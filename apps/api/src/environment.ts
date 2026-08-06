import {
	createJobFactory,
	createRateLimitStage,
	createRouteFactory,
	type FactoryDeps,
	type JobContext,
	type JobFactory,
	pipeline,
	type RateLimitPreset,
	type RequestContext,
} from '@declarativejs/core';
import {
	type AppEnvironment,
	assembleDeps,
	consoleLogger,
	type EnvironmentInput,
} from '@declarativejs/core/app';
import { createMemoryRateLimiter } from '@declarativejs/module-rate-limit';
import {
	createNpmClient,
	createOsvClient,
	type OsvClient,
} from '@workspace/audit-engine';
import {
	createGithubClient,
	type GithubClient,
} from './adapters/github/client';
import {
	createRepoReader,
	type RepoReader,
} from './adapters/github/repo-reader';
import { createRegistryCachePort } from './adapters/registry-cache-port';
import { auth } from './auth/auth';
import { isSetupRequired } from './auth/bootstrap';
import { type AuthProvides, createAuthStage } from './auth/stage';
import { db, sqlite } from './db';
import { env } from './env';
import {
	type AdvisoryRefreshService,
	createAdvisoryRefreshService,
} from './services/advisory-refresh-service';
import {
	channelConfigAad,
	globalTokenAad,
	projectTokenAad,
	secretBox,
} from './services/crypto-service';
import {
	createNotificationService,
	type NotificationService,
} from './services/notification-service';
import type { AutoPrPort, ScanNotifierPort } from './services/ports';
import { createPrService, type PrService } from './services/pr-service';
import { createScanService, type ScanService } from './services/scan-service';
import {
	createSchedulerService,
	type SchedulerService,
} from './services/scheduler-service';
import {
	type AdvisoriesStore,
	createAdvisoriesStore,
} from './stores/advisories';
import { type AuditLogStore, createAuditLogStore } from './stores/audit-log';
import {
	createDependencySetsStore,
	type DependencySetsStore,
} from './stores/dependency-sets';
import {
	createDependencyStatusStore,
	type DependencyStatusStore,
} from './stores/dependency-status';
import { createFindingsStore, type FindingsStore } from './stores/findings';
import {
	createNotificationsStore,
	type NotificationsStore,
} from './stores/notifications';
import {
	createPeerIssuesStore,
	type PeerIssuesStore,
} from './stores/peer-issues';
import type { ProjectRow } from './stores/projects';
import { createProjectsStore, type ProjectsStore } from './stores/projects';
import {
	createPullRequestsStore,
	type PullRequestsStore,
} from './stores/pull-requests';
import {
	createRegistryCacheStore,
	type RegistryCacheStore,
} from './stores/registry-cache';
import { createScansStore, type ScansStore } from './stores/scans';
import { createSettingsStore, type SettingsStore } from './stores/settings';

const RATE_PRESETS = {
	read: { limit: 300, windowSeconds: 60, scope: 'actor' },
	write: { limit: 60, windowSeconds: 60, scope: 'actor' },
	costly: { limit: 10, windowSeconds: 60, scope: 'actor' },
	anon: { limit: 60, windowSeconds: 60, scope: 'ip' },
} as const satisfies Record<string, RateLimitPreset>;

/**
 * The hand-written composition seam: concrete adapters + the STATIC pipeline
 * `.use()` chains. Modules receive this env and never touch Elysia or the
 * adapters directly.
 *
 * Surfaces:
 * - `public` — no auth; IP-scoped rate limiting; health/readiness/bootstrap.
 * - `authed` — auth stage first (every route must declare `policy`;
 *   handlers gain ctx.user/role), then an actor-scoped rate-limit stage.
 */
function makeSurfaces(deps: FactoryDeps) {
	const limiter = createMemoryRateLimiter();

	const publicPipeline = pipeline<RequestContext>().use(
		createRateLimitStage(limiter, RATE_PRESETS, () => ({}))
	);

	const authedPipeline = pipeline<RequestContext>()
		.use(createAuthStage(auth))
		.use(
			createRateLimitStage<AuthProvides, typeof RATE_PRESETS>(
				limiter,
				RATE_PRESETS,
				(ctx) => ({ actorId: ctx.user.id })
			)
		);

	return {
		public: createRouteFactory({
			surface: 'public',
			pipeline: publicPipeline,
			deps,
		}),
		authed: createRouteFactory({
			surface: 'authed',
			pipeline: authedPipeline,
			deps,
			attribution: (ctx) => {
				const user = (ctx as Partial<AuthProvides>).user;
				return user === undefined
					? {}
					: { actorType: 'user', actorId: user.id };
			},
		}),
	};
}

type Surfaces = ReturnType<typeof makeSurfaces>;

/* -------------------------------------------------------------------------- */
/* Process-wide adapters                                                      */
/* -------------------------------------------------------------------------- */

const stores = {
	projects: createProjectsStore(db),
	scans: createScansStore(db),
	dependencySets: createDependencySetsStore(db),
	advisories: createAdvisoriesStore(db),
	findings: createFindingsStore(db),
	dependencyStatus: createDependencyStatusStore(db),
	peerIssues: createPeerIssuesStore(db),
	settings: createSettingsStore(db),
	auditLog: createAuditLogStore(db),
	registryCache: createRegistryCacheStore(db),
	pullRequests: createPullRequestsStore(db),
	notifications: createNotificationsStore(db, {
		seal: (channelId, config) =>
			secretBox.seal(JSON.stringify(config), channelConfigAad(channelId)),
		open: async (channelId, sealed) =>
			JSON.parse(
				await secretBox.open(sealed, channelConfigAad(channelId))
			) as Record<string, unknown>,
	}),
};

// The registry and OSV clients are stateless and token-free, so they are built
// ONCE and shared. The GitHub client is not: its token varies per project, so
// it is constructed per scan / per request instead.
const registryCachePort = createRegistryCachePort(stores.registryCache);
const npmClient = createNpmClient({
	fetch,
	cache: registryCachePort,
	registryUrl: env.NPM_REGISTRY_URL,
});
const osvClient = createOsvClient({ fetch, baseUrl: env.OSV_API_URL });

export interface GithubAccess {
	/** Client + reader bound to an explicit token (or the global fallback). */
	forToken(token?: string): { client: GithubClient; reader: RepoReader };
	/** project token → global settings token → GITHUB_TOKEN. */
	resolveToken(project: ProjectRow | null): Promise<string | undefined>;
}

const github: GithubAccess = {
	forToken(token) {
		const client = createGithubClient({
			apiUrl: env.GITHUB_API_URL,
			token,
			cache: stores.registryCache,
		});
		return { client, reader: createRepoReader(client) };
	},
	async resolveToken(project) {
		if (project !== null && project.githubTokenEnc !== null) {
			return secretBox.open(
				project.githubTokenEnc,
				projectTokenAad(project.id)
			);
		}
		const global = await stores.settings.getGithubDefaultTokenEnc();
		if (global !== null) return secretBox.open(global, globalTokenAad());
		return env.GITHUB_TOKEN;
	},
};

export interface SecretAccess {
	/** Seals a PAT for a project row and returns its display suffix. */
	sealProjectToken(
		projectId: string,
		token: string
	): Promise<{ sealed: string; last4: string }>;
}

const secrets: SecretAccess = {
	async sealProjectToken(projectId, token) {
		return {
			sealed: await secretBox.seal(token, projectTokenAad(projectId)),
			last4: token.slice(-4),
		};
	},
};

export interface AppEnv extends AppEnvironment {
	readonly surfaces: Surfaces;
	/** The scheduled-entrypoint factory — jobs are declared with it, never with timers. */
	readonly job: JobFactory<object, object>;
	readonly db: typeof db;
	readonly settings: SettingsStore;
	readonly auditLog: AuditLogStore;
	readonly projects: ProjectsStore;
	readonly scans: ScansStore;
	readonly dependencySets: DependencySetsStore;
	readonly advisories: AdvisoriesStore;
	readonly findings: FindingsStore;
	readonly dependencyStatus: DependencyStatusStore;
	readonly peerIssues: PeerIssuesStore;
	readonly registryCache: RegistryCacheStore;
	readonly pullRequests: PullRequestsStore;
	readonly notifications: NotificationsStore;
	readonly scanService: ScanService;
	readonly schedulerService: SchedulerService;
	readonly notificationService: NotificationService;
	readonly prService: PrService;
	readonly advisoryRefreshService: AdvisoryRefreshService;
	/** Stateless, shared across every scan and the advisory-refresh job — see the comment on `npmClient`/`osvClient` below. */
	readonly osv: OsvClient;
	readonly notifier: ScanNotifierPort;
	/** The scan pipeline's outbound seam into the PR service. */
	readonly autoPr: AutoPrPort;
	readonly github: GithubAccess;
	readonly secrets: SecretAccess;
	/** True while no admin account exists — drives the one-time signup UI. */
	readonly isSetupRequired: () => Promise<boolean>;
	/** True once the process should refuse new work (draining). */
	readonly isReady: () => boolean;
}

export function createEnvironment(input: EnvironmentInput): AppEnv {
	const deps = assembleDeps({
		log: consoleLogger,
		telemetry: input.telemetry,
	});

	const notificationService = createNotificationService({
		notifications: stores.notifications,
		projects: stores.projects,
		dependencyStatus: stores.dependencyStatus,
		baseUrl: env.APP_URL,
		log: deps.log,
	});

	const prService = createPrService({
		projects: stores.projects,
		scans: stores.scans,
		dependencySets: stores.dependencySets,
		dependencyStatus: stores.dependencyStatus,
		findings: stores.findings,
		pullRequests: stores.pullRequests,
		github,
		dispatchEvent: (event) => notificationService.dispatchEvent(event),
		config: {
			enableLockfileRegen: env.ENABLE_LOCKFILE_REGEN,
			appUrl: env.APP_URL,
		},
		log: deps.log,
	});

	const scanService = createScanService({
		projects: stores.projects,
		scans: stores.scans,
		dependencySets: stores.dependencySets,
		advisories: stores.advisories,
		findings: stores.findings,
		dependencyStatus: stores.dependencyStatus,
		peerIssues: stores.peerIssues,
		settings: stores.settings,
		registryCache: stores.registryCache,
		npm: npmClient,
		osv: osvClient,
		secretBox,
		projectTokenAad,
		globalTokenAad,
		config: {
			githubApiUrl: env.GITHUB_API_URL,
			githubToken: env.GITHUB_TOKEN,
			disableOsv: env.DISABLE_OSV,
		},
		notifier: notificationService.notifier,
		autoPr: prService.autoPr,
		log: deps.log,
	});

	const advisoryRefreshService = createAdvisoryRefreshService({
		advisories: stores.advisories,
		findings: stores.findings,
		osv: osvClient,
		log: deps.log,
	});

	const schedulerService = createSchedulerService({
		projects: stores.projects,
		scans: stores.scans,
		dependencySets: stores.dependencySets,
		registryCache: stores.registryCache,
		notifications: stores.notifications,
		settings: stores.settings,
		scanService,
		concurrency: env.SCAN_CONCURRENCY,
		sqlite,
		log: deps.log,
	});

	return {
		deps,
		surfaces: makeSurfaces(deps),
		job: createJobFactory({ pipeline: pipeline<JobContext>(), deps }),
		db,
		...stores,
		scanService,
		schedulerService,
		notificationService,
		prService,
		advisoryRefreshService,
		osv: osvClient,
		notifier: notificationService.notifier,
		autoPr: prService.autoPr,
		github,
		secrets,
		isSetupRequired: async () => isSetupRequired(sqlite),
		isReady: () => true,
	};
}
