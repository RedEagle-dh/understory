import type { LoggerPort } from '@declarativejs/core';
import {
	checkPeers,
	compareSeverity,
	computeFix,
	computeOutdated,
	type DependencyGraph,
	detectEcosystems,
	type EcosystemPort,
	ecosystemFor,
	mergeAdvisories,
	type NormalizedAdvisory,
	type NpmClient,
	normalizeNpmBulkResponse,
	normalizeOsvVuln,
	npmEcosystem,
	type OsvClient,
	type ParsedDependency,
	type PeerRequirement,
	type PypiClient,
	type Severity,
} from '@workspace/audit-engine';
import type { SecretBox } from '@workspace/db/crypto';
import { createGithubClient, GithubHttpError } from '../adapters/github/client';
import {
	createRepoReader,
	type RepoFile,
} from '../adapters/github/repo-reader';
import { NotFoundError, ScanInProgressError } from '../errors';
import type { AdvisoriesStore } from '../stores/advisories';
import type {
	DependencySetEntryRow,
	DependencySetsStore,
} from '../stores/dependency-sets';
import type {
	DependencyStatusInput,
	DependencyStatusStore,
} from '../stores/dependency-status';
import type { FindingMatch, FindingsStore } from '../stores/findings';
import type { PeerIssuesStore } from '../stores/peer-issues';
import type { ProjectRow, ProjectsStore } from '../stores/projects';
import type { RegistryCacheStore } from '../stores/registry-cache';
import type { ScanCounters, ScanRow, ScansStore } from '../stores/scans';
import type { SettingsStore } from '../stores/settings';
import type {
	AutoBumpSelection,
	AutoPrPort,
	AutoPrSelection,
	ScanNotifierPort,
} from './ports';
import { buildScanDiff, isEmptyDiff } from './scan-diff';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/** Composite-key separator that cannot occur in a package name or path. */
const NUL = String.fromCharCode(0);

const OSV_DETAIL_CONCURRENCY = 5;
const REGISTRY_CONCURRENCY = 5;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const BASE_BACKOFF_MS = 5 * 60 * 1000;
/** Failure streak lengths that emit a `scan_failed` notification. */
const FAILURE_NOTIFY_AT = new Set([1, 3, 10]);

const SEVERITY_RANK: Record<Severity, number> = {
	low: 0,
	moderate: 1,
	high: 2,
	critical: 3,
};
const BUMP_RANK = { patch: 0, minor: 1, major: 2 } as const;

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface ScanConfig {
	githubApiUrl: string;
	/** Last-resort GitHub token when neither project nor settings supply one. */
	githubToken?: string;
	disableOsv: boolean;
}

export interface ScanServiceDeps {
	projects: ProjectsStore;
	scans: ScansStore;
	dependencySets: DependencySetsStore;
	advisories: AdvisoriesStore;
	findings: FindingsStore;
	dependencyStatus: DependencyStatusStore;
	peerIssues: PeerIssuesStore;
	settings: SettingsStore;
	registryCache: RegistryCacheStore;
	npm: NpmClient;
	pypi: PypiClient;
	osv: OsvClient;
	secretBox: SecretBox;
	projectTokenAad: (projectId: string) => string;
	globalTokenAad: () => string;
	config: ScanConfig;
	notifier: ScanNotifierPort;
	autoPr: AutoPrPort;
	log?: LoggerPort;
	fetchImpl?: typeof fetch;
}

export type ScanTrigger = 'manual' | 'schedule' | 'auto';

export interface ScanResult {
	scanId: string;
	projectId: string;
	status: 'ok' | 'failed';
	depsReused: boolean;
	counters: ScanCounters;
	warnings: string[];
	errorCode?: string;
	errorMessage?: string;
}

const EMPTY_COUNTERS: ScanCounters = {
	totalDeps: 0,
	directDeps: 0,
	peerDeps: 0,
	vulnCritical: 0,
	vulnHigh: 0,
	vulnModerate: 0,
	vulnLow: 0,
	outdatedCount: 0,
	majorOutdatedCount: 0,
	newFindings: 0,
	resolvedFindings: 0,
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Exported for `advisory-refresh-service.ts`, which needs the same bounded-fan-out shape for OSV detail fetches. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	async function run(): Promise<void> {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			const item = items[index];
			if (item === undefined) continue;
			results[index] = await worker(item);
		}
	}
	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
			run()
		)
	);
	return results;
}

/**
 * `sha256` over every manifest as `path\0content`, path-sorted. Identical
 * content on any branch or repo yields an identical hash, which is exactly
 * what makes the dependency set content-addressable.
 */
export function computeLockHash(files: readonly RepoFile[]): string {
	const hasher = new Bun.CryptoHasher('sha256');
	for (const file of [...files].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0
	)) {
		hasher.update(file.path + NUL + file.content);
	}
	return hasher.digest('hex');
}

/**
 * Next scheduled run after a success.
 *
 * `interval` defines a fixed grid of slots anchored at the epoch; the project's
 * deterministic `scanOffsetSeconds` picks a position inside its slot so 100
 * projects on the same interval spread evenly instead of all firing on the
 * hour. Concretely: take `now + interval`, snap it down to the enclosing grid
 * boundary, add the offset, and step forward one grid if that already passed.
 * The snap therefore moves the naive candidate by at most one interval.
 */
export function alignedNextScanAt(
	now: Date,
	intervalMinutes: number,
	offsetSeconds: number
): Date {
	const gridMs = Math.max(1, intervalMinutes) * 60_000;
	const offsetMs =
		(offsetSeconds % (Math.max(1, intervalMinutes) * 60)) * 1000;
	const candidate = now.getTime() + gridMs;
	let aligned = Math.floor(candidate / gridMs) * gridMs + offsetMs;
	if (aligned <= now.getTime()) aligned += gridMs;
	return new Date(aligned);
}

/**
 * Next scheduled run after a failure: exponential from 5 minutes, never longer
 * than the project's own interval (a broken project should not silently stop
 * being retried at its normal cadence), and hard-capped at 6h for projects
 * configured with day-long intervals.
 */
export function backoffNextScanAt(
	now: Date,
	intervalMinutes: number,
	consecutiveFailures: number
): Date {
	const exponential =
		BASE_BACKOFF_MS * 2 ** Math.min(consecutiveFailures, 20);
	const bounded = Math.min(
		Math.max(1, intervalMinutes) * 60_000,
		exponential
	);
	return new Date(now.getTime() + Math.min(MAX_BACKOFF_MS, bounded));
}

function errorCodeFor(error: unknown): string {
	if (error instanceof GithubHttpError) return `GITHUB_HTTP_${error.status}`;
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof (error as { code: unknown }).code === 'string'
	) {
		return (error as { code: string }).code;
	}
	if (error instanceof Error && error.name !== 'Error') {
		return error.name
			.replace(/Error$/, '')
			.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
			.toUpperCase();
	}
	return 'SCAN_FAILED';
}

function parseJsonArray(value: string | null): string[] | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === 'string')
			: null;
	} catch {
		return null;
	}
}

function parsePeerDeps(
	value: string | null
): Record<string, PeerRequirement> | undefined {
	if (value === null) return undefined;
	try {
		return JSON.parse(value) as Record<string, PeerRequirement>;
	} catch {
		return undefined;
	}
}

/**
 * Per-ecosystem view of a registry, reduced to what the outdated and fix
 * passes actually consume. npm answers from packuments and dist-tags; PyPI
 * answers everything from one cached project document.
 */
interface ReleaseSummary {
	tags: { latest?: string };
	versions: { version: string; deprecated?: string }[];
}

interface RegistryProvider {
	/** Full release listing — fix computation + outdated for loaded names. */
	releases(name: string): Promise<ReleaseSummary>;
	/** Cheap `latest` lookup for names that skip the full listing. */
	latestTags(name: string): Promise<{ latest?: string }>;
	/** version → publish ISO time; feeds the auto-bump supply-chain cooldown. */
	publishTimes(name: string): Promise<Record<string, string>>;
}

function createNpmProvider(npm: NpmClient): RegistryProvider {
	return {
		async releases(name) {
			const packument = await npm.getPackument(name);
			return {
				tags: packument['dist-tags'] ?? {},
				versions: Object.values(packument.versions).map((version) => ({
					version: version.version,
					deprecated: version.deprecated,
				})),
			};
		},
		latestTags: (name) => npm.getDistTags(name),
		publishTimes: (name) => npm.getPublishTimes(name),
	};
}

function createPypiProvider(pypi: PypiClient): RegistryProvider {
	const summarize = async (name: string): Promise<ReleaseSummary> => {
		const project = await pypi.getProject(name);
		return {
			tags:
				project.latest === undefined ? {} : { latest: project.latest },
			versions: project.releases.map((release) => ({
				version: release.version,
				deprecated: release.yanked
					? (release.yankedReason ?? 'yanked')
					: undefined,
			})),
		};
	};
	return {
		releases: summarize,
		// Same endpoint; the client's cache makes the second hit free.
		latestTags: async (name) => (await summarize(name)).tags,
		publishTimes: (name) => pypi.getPublishTimes(name),
	};
}

/** Rebuild the engine's graph shape from stored entries (works when reused). */
function graphFromEntries(
	ecosystem: DependencyGraph['ecosystem'],
	manager: DependencyGraph['manager'],
	entries: readonly DependencySetEntryRow[]
): DependencyGraph {
	const dependencies: ParsedDependency[] = entries.map((entry) => ({
		name: entry.name,
		version: entry.version,
		workspace: entry.workspace,
		depType: entry.depType,
		isDirect: entry.isDirect,
		depth: entry.depth,
		declaredRange: entry.declaredRange ?? undefined,
		peerDeps: parsePeerDeps(entry.peerDepsJson),
		resolved: entry.resolved ?? undefined,
	}));
	return {
		ecosystem,
		manager,
		workspaces: [
			...new Set(entries.map((entry) => entry.workspace)),
		].sort(),
		dependencies,
		warnings: [],
	};
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export function createScanService(deps: ScanServiceDeps) {
	/** In-process mutex: one scan per project per node. */
	const inFlight = new Set<string>();
	const log = deps.log;

	async function resolveToken(
		project: ProjectRow
	): Promise<string | undefined> {
		if (project.githubTokenEnc !== null) {
			return deps.secretBox.open(
				project.githubTokenEnc,
				deps.projectTokenAad(project.id)
			);
		}
		const global = await deps.settings.getGithubDefaultTokenEnc();
		if (global !== null) {
			return deps.secretBox.open(global, deps.globalTokenAad());
		}
		return deps.config.githubToken;
	}

	/* ---------------------------------------------------------------- */
	/* Steps 4-7: advisory ingestion                                     */
	/* ---------------------------------------------------------------- */

	async function ingestAdvisories(
		port: EcosystemPort,
		nameVersions: Map<string, Set<string>>,
		skipOsv: boolean,
		warnings: string[]
	): Promise<void> {
		let npmAdvisories: NormalizedAdvisory[] = [];
		// npm's bulk endpoint has no equivalent for other ecosystems — there
		// OSV (GHSA + PYSEC) is the sole advisory source.
		if (port.ecosystem === 'npm') {
			const bulkInput: Record<string, string[]> = {};
			for (const [name, versions] of nameVersions) {
				bulkInput[name] = [...versions];
			}
			try {
				npmAdvisories = normalizeNpmBulkResponse(
					await deps.npm.bulkAdvisories(bulkInput)
				);
			} catch (error) {
				// npm's bulk endpoint is the primary source; losing it degrades
				// the scan but must not lose the outdated/peer passes.
				warnings.push(
					`npm bulk advisories failed: ${messageOf(error)}`
				);
			}
		}

		let osvAdvisories: NormalizedAdvisory[] = [];
		if (!skipOsv) {
			try {
				osvAdvisories = await fetchOsvAdvisories(port, nameVersions);
			} catch (error) {
				warnings.push(`OSV lookup failed: ${messageOf(error)}`);
			}
		}

		const merged = mergeAdvisories([npmAdvisories, osvAdvisories]);
		if (merged.length > 0) await deps.advisories.upsertMerged(merged);
	}

	async function fetchOsvAdvisories(
		port: EcosystemPort,
		nameVersions: Map<string, Set<string>>
	): Promise<NormalizedAdvisory[]> {
		const pairs: { name: string; version: string; ecosystem: string }[] =
			[];
		for (const [name, versions] of nameVersions) {
			for (const version of versions) {
				pairs.push({
					name,
					version,
					ecosystem: port.osvEcosystem,
				});
			}
		}
		if (pairs.length === 0) return [];

		const results = await deps.osv.queryBatch(pairs);
		const modifiedById = new Map<string, string | undefined>();
		for (const result of results) {
			for (const vuln of result.vulns) {
				if (!modifiedById.has(vuln.id)) {
					modifiedById.set(vuln.id, vuln.modified);
				}
			}
		}
		if (modifiedById.size === 0) return [];

		// Skip detail fetches whose upstream `modified` has not advanced.
		const known = await deps.advisories.getSourceModified([
			...modifiedById.keys(),
		]);
		const stale = [...modifiedById.entries()]
			.filter(([sourceId, modified]) => {
				const stored = known.get(sourceId);
				if (stored === undefined || stored === null) return true;
				if (modified === undefined) return false;
				return stored.getTime() !== Date.parse(modified);
			})
			.map(([sourceId]) => sourceId);

		const vulns = await mapWithConcurrency(
			stale,
			OSV_DETAIL_CONCURRENCY,
			async (sourceId) => {
				try {
					return await deps.osv.getVuln(sourceId);
				} catch {
					return null;
				}
			}
		);
		return vulns
			.filter((vuln) => vuln !== null)
			.map((vuln) =>
				normalizeOsvVuln(vuln, {
					ecosystem: port.ecosystem,
				})
			);
	}

	/* ---------------------------------------------------------------- */
	/* Step 8-10: matching + fix computation                             */
	/* ---------------------------------------------------------------- */

	async function loadReleases(
		provider: RegistryProvider,
		names: readonly string[],
		warnings: string[]
	): Promise<Map<string, ReleaseSummary>> {
		const out = new Map<string, ReleaseSummary>();
		await mapWithConcurrency(names, REGISTRY_CONCURRENCY, async (name) => {
			try {
				out.set(name, await provider.releases(name));
			} catch (error) {
				warnings.push(`releases ${name}: ${messageOf(error)}`);
			}
		});
		return out;
	}

	/* ---------------------------------------------------------------- */
	/* Orchestration                                                     */
	/* ---------------------------------------------------------------- */

	async function runPipeline(
		project: ProjectRow,
		scan: ScanRow
	): Promise<ScanResult> {
		const warnings: string[] = [];
		const token = await resolveToken(project);

		// The client is per-scan because the token varies per project.
		const client = createGithubClient({
			apiUrl: deps.config.githubApiUrl,
			token,
			cache: deps.registryCache,
			fetchImpl: deps.fetchImpl,
		});
		const reader = createRepoReader(client);

		const snapshot = await reader.snapshot(
			{
				owner: project.owner,
				repo: project.repo,
				branch: project.branch,
			},
			parseJsonArray(project.manifestPathsJson)
		);
		warnings.push(...snapshot.warnings);
		if (client.isQuotaLow()) {
			warnings.push(
				`GitHub rate limit is low (${client.rateLimitRemaining() ?? '?'} remaining)`
			);
		}

		const lockHash = computeLockHash(snapshot.files);

		// One ecosystem per scan: registry order (npm first) breaks ties in
		// polyglot repositories until multi-set scans land.
		const present = detectEcosystems(snapshot.files);
		if (present.length > 1) {
			warnings.push(
				`repository contains multiple ecosystems (${present
					.map((candidate) => candidate.ecosystem)
					.join(
						', '
					)}); scanning ${(present[0] as EcosystemPort).ecosystem} only`
			);
		}

		// Reuse whenever a set already exists for this content hash: re-parsing
		// identical manifests can only produce the identical set, and the
		// (projectId, lockHash) unique index would reject the duplicate anyway.
		let setRow = await deps.dependencySets.findByLockHash(
			project.id,
			lockHash
		);
		const depsReused = setRow !== null;
		if (setRow === null) {
			const graph = (present[0] ?? npmEcosystem).parse(snapshot.files);
			setRow = await deps.dependencySets.create({
				projectId: project.id,
				lockHash,
				manager: graph.manager,
				graph,
				firstScanId: scan.id,
			});
		}
		// Parse warnings ride on the SET (parsing only happens at creation) so
		// a reused scan still reports "no lockfile found" instead of silently
		// presenting an empty graph as healthy.
		const setWarnings = parseJsonArray(setRow.warningsJson);
		if (setWarnings !== null) warnings.push(...setWarnings);
		// The stored set is authoritative on reuse — identical content implies
		// identical detection, and this keeps reused scans self-consistent.
		const port = ecosystemFor(setRow.ecosystem);
		const provider =
			port.ecosystem === 'npm'
				? createNpmProvider(deps.npm)
				: createPypiProvider(deps.pypi);

		const entries = await deps.dependencySets.entriesForSet(setRow.id);
		const graph = graphFromEntries(
			setRow.ecosystem,
			setRow.manager,
			entries
		);

		const nameVersions = new Map<string, Set<string>>();
		for (const entry of entries) {
			const versions = nameVersions.get(entry.name);
			if (versions === undefined) {
				nameVersions.set(entry.name, new Set([entry.version]));
			} else {
				versions.add(entry.version);
			}
		}

		// A reused dependency set was already queried against OSV on the scan
		// that created it; only npm's cheap bulk endpoint is re-run hourly.
		await ingestAdvisories(
			port,
			nameVersions,
			deps.config.disableOsv || depsReused,
			warnings
		);

		const rangesByPackage = await deps.advisories.rangesForPackages(
			[...nameVersions.keys()],
			port.ecosystem
		);

		// findings are unique per (project, advisory, name, version); keep the
		// most informative occurrence when a package sits in several workspaces.
		const matchByKey = new Map<
			string,
			{
				entry: DependencySetEntryRow;
				advisoryId: string;
				severity: Severity;
			}
		>();
		for (const entry of entries) {
			for (const range of rangesByPackage.get(entry.name) ?? []) {
				if (
					!port.versioning.satisfies(
						entry.version,
						range.vulnerableRange
					)
				) {
					continue;
				}
				const key = [range.advisoryId, entry.name, entry.version].join(
					NUL
				);
				const existing = matchByKey.get(key);
				if (existing === undefined) {
					matchByKey.set(key, {
						entry,
						advisoryId: range.advisoryId,
						severity: range.severity,
					});
					continue;
				}
				if (compareSeverity(range.severity, existing.severity) > 0) {
					existing.severity = range.severity;
				}
				if (entry.isDirect && !existing.entry.isDirect) {
					existing.entry = entry;
				}
			}
		}

		const affectedNames = new Set(
			[...matchByKey.values()].map((match) => match.entry.name)
		);
		const directNames = new Set(
			entries.filter((entry) => entry.isDirect).map((entry) => entry.name)
		);
		const releases = await loadReleases(
			provider,
			[...new Set([...affectedNames, ...directNames])],
			warnings
		);

		const matches: FindingMatch[] = [...matchByKey.values()].map(
			({ entry, advisoryId, severity }) => {
				const fix = computeFix({
					currentVersion: entry.version,
					declaredRange: entry.declaredRange ?? undefined,
					allRangesForPackage: (
						rangesByPackage.get(entry.name) ?? []
					).map((range) => range.vulnerableRange),
					availableVersions: releases.get(entry.name)?.versions ?? [],
					versioning: port.versioning,
				});
				return {
					advisoryId,
					packageName: entry.name,
					packageVersion: entry.version,
					workspace: entry.workspace,
					severity,
					isDirect: entry.isDirect,
					depType: entry.depType,
					fixedIn: fix.fixedIn,
					fixType: fix.fixType,
					fixWithinRange:
						entry.declaredRange === null
							? null
							: fix.fixWithinRange,
				};
			}
		);

		const findingDelta = await deps.findings.syncForScan(
			project.id,
			scan.id,
			scan.startedAt,
			matches
		);

		await runOutdatedPass(
			project,
			scan,
			entries,
			releases,
			provider,
			port,
			warnings
		);

		const peerIssues = checkPeers(graph, {
			versioning: port.versioning,
		});
		await deps.peerIssues.syncForScan(project.id, scan.id, peerIssues);

		const [openCounts, outdatedCounts] = await Promise.all([
			deps.findings.openCounts(project.id),
			deps.dependencyStatus.outdatedCounts(project.id),
		]);

		const counters: ScanCounters = {
			totalDeps: entries.length,
			directDeps: entries.filter((entry) => entry.isDirect).length,
			peerDeps: entries.filter(
				(entry) =>
					entry.depType === 'peer' ||
					entry.depType === 'peer_optional'
			).length,
			vulnCritical: openCounts.critical,
			vulnHigh: openCounts.high,
			vulnModerate: openCounts.moderate,
			vulnLow: openCounts.low,
			outdatedCount: outdatedCounts.outdated,
			majorOutdatedCount: outdatedCounts.major,
			newFindings: findingDelta.new,
			resolvedFindings: findingDelta.resolved,
		};

		await deps.scans.succeed(scan.id, {
			commitSha: snapshot.commitSha,
			branch: snapshot.branch,
			dependencySetId: setRow.id,
			lockHash,
			depsReused,
			counters,
			warnings,
		});
		await deps.projects.finishScan(project.id, {
			scanId: scan.id,
			success: true,
			lockHash,
			nextScanAt: alignedNextScanAt(
				new Date(),
				project.scanIntervalMinutes,
				project.scanOffsetSeconds
			),
		});

		await dispatchDiffAndAutoPr(project, scan);
		await dispatchAutoBump(project, scan, provider);

		return {
			scanId: scan.id,
			projectId: project.id,
			status: 'ok',
			depsReused,
			counters,
			warnings,
		};
	}

	async function runOutdatedPass(
		project: ProjectRow,
		scan: ScanRow,
		entries: readonly DependencySetEntryRow[],
		releases: Map<string, ReleaseSummary>,
		provider: RegistryProvider,
		port: EcosystemPort,
		warnings: string[]
	): Promise<void> {
		// One status row per (workspace, package): prefer the direct
		// declaration, then the shallowest occurrence.
		const representative = new Map<string, DependencySetEntryRow>();
		for (const entry of entries) {
			const key = [entry.workspace, entry.name].join(NUL);
			const current = representative.get(key);
			if (
				current === undefined ||
				(entry.isDirect && !current.isDirect) ||
				(entry.isDirect === current.isDirect &&
					entry.depth < current.depth)
			) {
				representative.set(key, entry);
			}
		}

		const rows = [...representative.values()];
		const latestOnly = [
			...new Set(
				rows
					.map((entry) => entry.name)
					.filter((name) => !releases.has(name))
			),
		];
		const latestTags = new Map<string, { latest?: string }>();
		await mapWithConcurrency(
			latestOnly,
			REGISTRY_CONCURRENCY,
			async (name) => {
				try {
					latestTags.set(name, await provider.latestTags(name));
				} catch (error) {
					warnings.push(`latest ${name}: ${messageOf(error)}`);
				}
			}
		);

		const statuses: DependencyStatusInput[] = rows.map((entry) => {
			const summary = releases.get(entry.name);
			const tags = summary?.tags ?? latestTags.get(entry.name) ?? {};
			const outdated = computeOutdated({
				current: entry.version,
				declaredRange: entry.declaredRange ?? undefined,
				distTags: tags,
				versions:
					summary === undefined
						? undefined
						: Object.fromEntries(
								summary.versions.map((version) => [
									version.version,
									{ deprecated: version.deprecated },
								])
							),
				versioning: port.versioning,
			});
			return {
				workspace: entry.workspace,
				packageName: entry.name,
				currentVersion: entry.version,
				declaredRange: entry.declaredRange,
				wantedVersion: outdated.wanted ?? null,
				latestVersion: outdated.latest ?? null,
				isDirect: entry.isDirect,
				depType: entry.depType,
				updateKind: outdated.updateKind,
				deprecatedMessage: outdated.deprecated ?? null,
			};
		});

		await deps.dependencyStatus.replaceForScan(
			project.id,
			scan.id,
			scan.startedAt,
			statuses
		);
	}

	async function dispatchDiffAndAutoPr(
		project: ProjectRow,
		scan: ScanRow
	): Promise<void> {
		const diff = await buildScanDiff(
			{
				findings: deps.findings,
				dependencyStatus: deps.dependencyStatus,
			},
			project,
			scan.id,
			scan.startedAt
		);

		if (!isEmptyDiff(diff)) {
			try {
				await deps.notifier.scanDiff(diff);
			} catch (error) {
				log?.warn('scan diff notification failed', {
					projectId: project.id,
					error: messageOf(error),
				});
			}
		}

		if (!project.autoPrEnabled) return;
		const minSeverity = SEVERITY_RANK[project.autoPrMinSeverity];
		const maxBump = BUMP_RANK[project.autoPrMaxBump];

		/**
		 * Confirmed in-the-wild exploitation can outrank the severity label:
		 * CVSS is assigned once, before anyone was being attacked, while a KEV
		 * listing is a report that they now are. `autoPrMaxBump` still applies,
		 * so this never ships a surprise major.
		 */
		const kevIds =
			project.autoPrKevOverride && diff.newFindings.length > 0
				? await deps.advisories.kevListedIds(
						diff.newFindings.map((finding) => finding.advisoryId)
					)
				: new Set<string>();

		const selections: AutoPrSelection[] = diff.newFindings
			.filter(
				(finding) =>
					finding.fixedIn !== null &&
					finding.fixType !== null &&
					finding.fixType !== 'none' &&
					(SEVERITY_RANK[finding.severity] >= minSeverity ||
						kevIds.has(finding.advisoryId)) &&
					BUMP_RANK[finding.fixType] <= maxBump
			)
			.map((finding) => ({
				packageName: finding.packageName,
				workspace: finding.workspace,
				toVersion: finding.fixedIn as string,
				fixType: finding.fixType as AutoPrSelection['fixType'],
				advisoryId: finding.advisoryId,
				findingId: finding.findingId,
				severity: finding.severity,
			}));
		if (selections.length === 0) return;

		try {
			await deps.autoPr.maybeCreate({
				projectId: project.id,
				scanId: scan.id,
				selections,
			});
		} catch (error) {
			log?.warn('auto-PR dispatch failed', {
				projectId: project.id,
				error: messageOf(error),
			});
		}
	}

	/**
	 * Auto-bump: outdated (non-security) direct dependencies → one batched
	 * `auto_update` PR, gated by the project's max update kind and by the
	 * supply-chain cooldown (the target version must have been public for at
	 * least `autoBumpMinReleaseAgeHours`). Security auto-PRs are deliberately
	 * NOT gated by the cooldown — fixes want speed.
	 */
	async function dispatchAutoBump(
		project: ProjectRow,
		scan: ScanRow,
		provider: RegistryProvider
	): Promise<void> {
		if (!project.autoBumpEnabled) return;

		const maxKind = BUMP_RANK[project.autoBumpMaxKind];
		const kinds = (['patch', 'minor', 'major'] as const).filter(
			(kind) => BUMP_RANK[kind] <= maxKind
		);
		const { items } = await deps.dependencyStatus.listForProject(
			project.id,
			{ updateKind: kinds, isDirect: true, page: 1, pageSize: 500 }
		);

		const minAgeMs = project.autoBumpMinReleaseAgeHours * 60 * 60 * 1000;
		const cutoff = Date.now() - minAgeMs;
		const timesByPackage = new Map<string, Record<string, string>>();
		const selections: AutoBumpSelection[] = [];

		for (const row of items) {
			if (row.latestVersion === null) continue;
			if (row.latestVersion === row.currentVersion) continue;
			if (row.updateKind === 'none') continue;

			if (minAgeMs > 0) {
				let times = timesByPackage.get(row.packageName);
				if (times === undefined) {
					try {
						times = await provider.publishTimes(row.packageName);
					} catch (error) {
						log?.warn(
							'auto-bump: publish times unavailable — skipping package',
							{
								projectId: project.id,
								packageName: row.packageName,
								error: messageOf(error),
							}
						);
						times = {};
					}
					timesByPackage.set(row.packageName, times);
				}
				const publishedAt = times[row.latestVersion];
				// No timestamp = can't prove the cooldown passed → skip.
				// Conservative on purpose: this gate exists for supply-chain
				// safety, so unknown ages fail closed.
				if (publishedAt === undefined) continue;
				if (Date.parse(publishedAt) > cutoff) continue;
			}

			selections.push({
				packageName: row.packageName,
				workspace: row.workspace,
				toVersion: row.latestVersion,
				updateKind: row.updateKind,
			});
		}

		if (selections.length === 0) return;
		try {
			await deps.autoPr.maybeCreateBumps({
				projectId: project.id,
				scanId: scan.id,
				selections,
			});
		} catch (error) {
			log?.warn('auto-bump dispatch failed', {
				projectId: project.id,
				error: messageOf(error),
			});
		}
	}

	async function handleFailure(
		project: ProjectRow,
		scan: ScanRow,
		error: unknown
	): Promise<ScanResult> {
		const errorCode = errorCodeFor(error);
		const errorMessage = messageOf(error);
		const failures = project.consecutiveFailures + 1;

		log?.error('scan failed', {
			projectId: project.id,
			scanId: scan.id,
			errorCode,
			errorMessage,
		});

		try {
			await deps.scans.fail(scan.id, errorCode, errorMessage);
			await deps.projects.finishScan(project.id, {
				scanId: scan.id,
				success: false,
				nextScanAt: backoffNextScanAt(
					new Date(),
					project.scanIntervalMinutes,
					failures
				),
			});
		} catch (bookkeepingError) {
			log?.error('failed to record scan failure', {
				projectId: project.id,
				error: messageOf(bookkeepingError),
			});
		}

		if (FAILURE_NOTIFY_AT.has(failures)) {
			try {
				await deps.notifier.scanFailed({
					projectId: project.id,
					projectName: project.name,
					scanId: scan.id,
					errorCode,
					errorMessage,
					consecutiveFailures: failures,
				});
			} catch (notifyError) {
				log?.warn('scan failure notification failed', {
					projectId: project.id,
					error: messageOf(notifyError),
				});
			}
		}

		return {
			scanId: scan.id,
			projectId: project.id,
			status: 'failed',
			depsReused: false,
			counters: EMPTY_COUNTERS,
			warnings: [],
			errorCode,
			errorMessage,
		};
	}

	async function begin(
		projectId: string,
		trigger: ScanTrigger,
		actorUserId?: string
	): Promise<{ project: ProjectRow; scan: ScanRow }> {
		// Check AND claim before the first await: an async function body runs
		// synchronously up to its first `await`, so doing both here is what
		// makes two overlapping calls resolve to exactly one winner.
		if (inFlight.has(projectId)) throw new ScanInProgressError(projectId);
		inFlight.add(projectId);
		try {
			const project = await deps.projects.get(projectId);
			if (project === null) throw new NotFoundError('Project', projectId);
			const scan = await deps.scans.begin({
				projectId,
				trigger,
				triggeredBy: actorUserId,
			});
			return { project, scan };
		} catch (error) {
			inFlight.delete(projectId);
			throw error;
		}
	}

	async function execute(
		project: ProjectRow,
		scan: ScanRow
	): Promise<ScanResult> {
		try {
			return await runPipeline(project, scan);
		} catch (error) {
			return await handleFailure(project, scan, error);
		} finally {
			inFlight.delete(project.id);
		}
	}

	return {
		isRunning(projectId: string): boolean {
			return inFlight.has(projectId);
		},

		/**
		 * Awaits the `scans` row insert (so the id exists and 409s are decided
		 * synchronously) and returns immediately, leaving the pipeline running
		 * detached. `completed` never rejects — failures land in the scan row.
		 */
		async startScan(
			projectId: string,
			trigger: ScanTrigger,
			actorUserId?: string
		): Promise<{ scanId: string; completed: Promise<ScanResult> }> {
			const { project, scan } = await begin(
				projectId,
				trigger,
				actorUserId
			);
			return { scanId: scan.id, completed: execute(project, scan) };
		},

		/** Runs a scan to completion. Throws only ScanInProgress / NotFound. */
		async runScan(
			projectId: string,
			trigger: ScanTrigger,
			actorUserId?: string
		): Promise<ScanResult> {
			const { project, scan } = await begin(
				projectId,
				trigger,
				actorUserId
			);
			return execute(project, scan);
		},
	};
}

export type ScanService = ReturnType<typeof createScanService>;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
