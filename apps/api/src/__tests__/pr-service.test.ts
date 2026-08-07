import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLockfile, parsePypi } from '@workspace/audit-engine';
import { createDb, runMigrations, schema } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { createGithubClient } from '../adapters/github/client';
import { createRepoReader } from '../adapters/github/repo-reader';
import { InvalidInputError, PrAlreadyOpenError } from '../errors';
import {
	type LockfileRegenInput,
	regenerateLockfile,
} from '../services/lockfile-regen';
import type {
	PrMergedEvent,
	PrOpenedEvent,
} from '../services/notification-service';
import {
	applyRangeEdits,
	branchNameFor,
	createPrService,
} from '../services/pr-service';
import { createAdvisoriesStore } from '../stores/advisories';
import { createDependencySetsStore } from '../stores/dependency-sets';
import { createDependencyStatusStore } from '../stores/dependency-status';
import { createFindingsStore } from '../stores/findings';
import { createProjectsStore } from '../stores/projects';
import { createPullRequestsStore } from '../stores/pull-requests';
import { createScansStore } from '../stores/scans';

/* -------------------------------------------------------------------------- */
/* Fixture repository                                                         */
/* -------------------------------------------------------------------------- */

const GITHUB_URL = 'https://api.github.com';
const GHSA = 'GHSA-35jh-r3h4-6jhm';

/** 4-space indented on purpose: the edit must not reformat the whole file. */
const PACKAGE_JSON = `{
    "name": "fixture-app",
    "version": "1.0.0",
    "dependencies": {
        "lodash": "^4.17.15",
        "minimist": "1.2.0",
        "wildcard-dep": "*",
        "linked-dep": "workspace:*"
    },
    "devDependencies": {
        "left-pad": "^1.3.0"
    }
}
`;

function lockfile(): string {
	return JSON.stringify(
		{
			name: 'fixture-app',
			version: '1.0.0',
			lockfileVersion: 3,
			requires: true,
			packages: {
				'': {
					name: 'fixture-app',
					version: '1.0.0',
					dependencies: {
						lodash: '^4.17.15',
						minimist: '1.2.0',
						'wildcard-dep': '*',
						'linked-dep': 'workspace:*',
					},
					devDependencies: { 'left-pad': '^1.3.0' },
				},
				'node_modules/lodash': { version: '4.17.15' },
				'node_modules/minimist': { version: '1.2.0' },
				'node_modules/wildcard-dep': { version: '1.0.0' },
				'node_modules/linked-dep': { version: '0.1.0' },
				'node_modules/left-pad': { version: '1.3.0', dev: true },
			},
		},
		null,
		2
	);
}

const DEFAULT_FILES: Record<string, string> = {
	'package.json': PACKAGE_JSON,
	'package-lock.json': lockfile(),
};

/* -------------------------------------------------------------------------- */
/* Catalog monorepo fixture — the shape that used to be un-bumpable           */
/* -------------------------------------------------------------------------- */

/** Root: owns BOTH catalogs; the only file a catalog bump may edit. */
const CATALOG_ROOT_JSON = `{
    "name": "fixture-monorepo",
    "private": true,
    "workspaces": ["apps/*"],
    "catalog": {
        "left-pad": "^1.3.0"
    },
    "catalogs": {
        "frontend": {
            "react": "^19.2.0"
        }
    }
}
`;

/** Workspace: declares nothing but `catalog:` pointers. */
const CATALOG_WEB_JSON = `{
    "name": "@fixture/web",
    "version": "1.0.0",
    "dependencies": {
        "react": "catalog:frontend",
        "left-pad": "catalog:"
    }
}
`;

const CATALOG_BUN_LOCK = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "fixture-monorepo" },
    "apps/web": {
      "name": "@fixture/web",
      "version": "1.0.0",
      "dependencies": { "react": "catalog:frontend", "left-pad": "catalog:" },
    },
  },
  "catalog": { "left-pad": "^1.3.0" },
  "catalogs": { "frontend": { "react": "^19.2.0" } },
  "packages": {
    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-fixture"],
    "react": ["react@19.2.0", "", {}, "sha512-fixture"],
    "@fixture/web": ["@fixture/web@workspace:apps/web"],
  }
}
`;

const CATALOG_FILES: Record<string, string> = {
	'package.json': CATALOG_ROOT_JSON,
	'apps/web/package.json': CATALOG_WEB_JSON,
	'bun.lock': CATALOG_BUN_LOCK,
};

/* -------------------------------------------------------------------------- */
/* GitHub double                                                              */
/* -------------------------------------------------------------------------- */

interface GithubCall {
	method: string;
	path: string;
	body: Record<string, unknown> | null;
}

interface GithubScript {
	calls: GithubCall[];
	/** Blobs posted, in order — lets a test decode the file we committed. */
	blobs: string[];
	branchExists: boolean;
	pullExists: boolean;
	pullState: {
		state: 'open' | 'closed';
		merged: boolean;
		merged_at: string | null;
		closed_at: string | null;
	};
	/** Repository contents by repo-relative path; drives the tree listing. */
	files: Record<string, string>;
	/** Alias for `files['package.json']`. */
	packageJson: string;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function makeGithub(files: Record<string, string>): {
	script: GithubScript;
	fetch: typeof fetch;
	writes: () => string[];
} {
	const script: GithubScript = {
		calls: [],
		blobs: [],
		branchExists: false,
		pullExists: false,
		pullState: {
			state: 'open',
			merged: false,
			merged_at: null,
			closed_at: null,
		},
		files: { ...files },
		get packageJson(): string {
			return script.files['package.json'] ?? '';
		},
		set packageJson(value: string) {
			script.files['package.json'] = value;
		},
	};

	let blobCounter = 0;

	const fakeFetch = (async (
		input: unknown,
		init?: { method?: string; body?: string }
	): Promise<Response> => {
		const url = typeof input === 'string' ? input : String(input);
		if (!url.startsWith(GITHUB_URL)) {
			throw new Error(`unexpected fetch: ${url}`);
		}
		const path = url.slice(GITHUB_URL.length);
		const method = init?.method ?? 'GET';
		const body =
			init?.body === undefined
				? null
				: (JSON.parse(init.body) as Record<string, unknown>);
		script.calls.push({ method, path, body });

		/* ---------------------------- git data ------------------------ */
		if (method === 'GET' && path.includes('/git/ref/heads/')) {
			return json({ object: { sha: 'base-sha' } });
		}
		if (method === 'GET' && path.includes('/git/commits/')) {
			return json({ sha: 'base-sha', tree: { sha: 'base-tree-sha' } });
		}

		/* ---------------------------- repo reads ---------------------- */
		if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
			return json({ default_branch: 'main' });
		}
		if (method === 'GET' && path.includes('/commits/')) {
			return json({ sha: 'base-sha' });
		}
		if (method === 'GET' && path.includes('/git/trees/')) {
			return json({
				truncated: false,
				tree: Object.keys(script.files).map((file) => ({
					path: file,
					type: 'blob',
				})),
			});
		}
		if (method === 'GET' && path.includes('/contents/')) {
			const marker = '/contents/';
			const relative = decodeURIComponent(
				path
					.slice(path.indexOf(marker) + marker.length)
					.split('?')[0] ?? ''
			);
			const content = script.files[relative];
			return content === undefined
				? json({ message: `no content for ${relative}` }, 404)
				: new Response(content);
		}
		if (method === 'POST' && path.endsWith('/git/refs')) {
			if (script.branchExists) {
				return json({ message: 'Reference already exists' }, 422);
			}
			script.branchExists = true;
			return json({ ref: String(body?.ref) });
		}
		if (method === 'POST' && path.endsWith('/git/blobs')) {
			script.blobs.push(String(body?.content ?? ''));
			blobCounter += 1;
			return json({ sha: `blob-${blobCounter}` });
		}
		if (method === 'POST' && path.endsWith('/git/trees')) {
			return json({ sha: 'new-tree-sha' });
		}
		if (method === 'POST' && path.endsWith('/git/commits')) {
			return json({
				sha: 'new-commit-sha',
				tree: { sha: 'new-tree-sha' },
			});
		}
		if (method === 'PATCH' && path.includes('/git/refs/heads/')) {
			return json({ object: { sha: 'new-commit-sha' } });
		}

		/* ---------------------------- pulls --------------------------- */
		if (method === 'POST' && path.endsWith('/pulls')) {
			if (script.pullExists) {
				return json(
					{
						message:
							'A pull request already exists for acme:understory/security-x.',
					},
					422
				);
			}
			script.pullExists = true;
			return json({
				number: 42,
				html_url: 'https://github.com/acme/fixture-app/pull/42',
				state: 'open',
			});
		}
		if (
			method === 'GET' &&
			path.startsWith('/repos/acme/fixture-app/pulls?')
		) {
			return json([
				{
					number: 42,
					html_url: 'https://github.com/acme/fixture-app/pull/42',
					state: 'open',
				},
			]);
		}
		if (method === 'GET' && /\/pulls\/\d+$/.test(path)) {
			return json({
				number: 42,
				html_url: 'https://github.com/acme/fixture-app/pull/42',
				...script.pullState,
			});
		}
		if (method === 'POST' && path.includes('/labels')) {
			return json([{ name: 'dependencies' }]);
		}

		return json({ message: `unhandled ${method} ${path}` }, 404);
	}) as unknown as typeof fetch;

	return {
		script,
		fetch: fakeFetch,
		/**
		 * The PR-writing half of the conversation as `METHOD path`; the
		 * repo-reader's own recursive tree listing is filtered out so the
		 * assertion reads as the Git Data sequence and nothing else.
		 */
		writes: () =>
			script.calls
				.filter(
					(call) =>
						(call.path.includes('/git/') ||
							call.path.includes('/pulls')) &&
						!(
							call.method === 'GET' &&
							call.path.includes('/git/trees/')
						)
				)
				.map((call) => `${call.method} ${call.path.split('?')[0]}`),
	};
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
	db: ReturnType<typeof createDb>['db'];
	service: ReturnType<typeof createPrService>;
	stores: {
		projects: ReturnType<typeof createProjectsStore>;
		pullRequests: ReturnType<typeof createPullRequestsStore>;
	};
	github: ReturnType<typeof makeGithub>;
	events: (PrOpenedEvent | PrMergedEvent)[];
	regenResult: { ok: boolean; content?: string; reason?: string };
	regenCalls: number;
	/** Every argument object the service handed to lockfile regeneration. */
	regenInputs: LockfileRegenInput[];
	projectId: string;
}

async function makeHarness(
	options: {
		enableLockfileRegen?: boolean;
		/** Repository contents; defaults to the single-package fixture. */
		files?: Record<string, string>;
	} = {}
): Promise<Harness> {
	const { db } = createDb(':memory:');
	runMigrations(db);
	db.insert(schema.appSettings)
		.values({ id: 1, createdAt: new Date(), updatedAt: new Date() })
		.run();

	const files = options.files ?? DEFAULT_FILES;
	const github = makeGithub(files);
	const events: (PrOpenedEvent | PrMergedEvent)[] = [];

	const projects = createProjectsStore(db);
	const scans = createScansStore(db);
	const dependencySets = createDependencySetsStore(db);
	const dependencyStatus = createDependencyStatusStore(db);
	const findings = createFindingsStore(db);
	const advisories = createAdvisoriesStore(db);
	const pullRequests = createPullRequestsStore(db);

	const project = await projects.create({
		name: 'fixture-app',
		owner: 'acme',
		repo: 'fixture-app',
		branch: 'main',
	});

	/* --------------------------- seed a scan ---------------------------- */
	const scan = await scans.begin({
		projectId: project.id,
		trigger: 'manual',
	});
	const graph = parseLockfile(
		Object.entries(files).map(([path, content]) => ({ path, content }))
	);
	const setRow = await dependencySets.create({
		projectId: project.id,
		lockHash: 'hash-1',
		manager: graph.manager,
		graph,
		firstScanId: scan.id,
	});
	await scans.succeed(scan.id, {
		commitSha: 'base-sha',
		branch: 'main',
		dependencySetId: setRow.id,
		lockHash: 'hash-1',
		depsReused: false,
		counters: {
			totalDeps: 5,
			directDeps: 5,
			peerDeps: 0,
			vulnCritical: 0,
			vulnHigh: 1,
			vulnModerate: 0,
			vulnLow: 0,
			outdatedCount: 2,
			majorOutdatedCount: 0,
			newFindings: 1,
			resolvedFindings: 0,
		},
	});
	await projects.finishScan(project.id, {
		scanId: scan.id,
		success: true,
		lockHash: 'hash-1',
		nextScanAt: new Date(Date.now() + 3_600_000),
	});

	/* ------------------------ seed advisory + finding ------------------- */
	db.insert(schema.advisories)
		.values({
			id: GHSA,
			summary: 'Command injection in lodash',
			severity: 'high',
			url: `https://github.com/advisories/${GHSA}`,
			updatedAt: new Date(),
		})
		.run();
	db.insert(schema.advisories)
		.values({
			id: 'GHSA-minimist',
			summary: 'Prototype pollution in minimist',
			severity: 'high',
			url: 'https://github.com/advisories/GHSA-minimist',
			updatedAt: new Date(),
		})
		.run();
	await findings.syncForScan(project.id, scan.id, new Date(), [
		{
			advisoryId: GHSA,
			packageName: 'lodash',
			packageVersion: '4.17.15',
			workspace: '',
			severity: 'high',
			isDirect: true,
			depType: 'prod',
			fixedIn: '4.17.21',
			fixType: 'patch',
			fixWithinRange: true,
		},
		{
			advisoryId: 'GHSA-minimist',
			packageName: 'minimist',
			packageVersion: '1.2.0',
			workspace: '',
			severity: 'high',
			isDirect: true,
			depType: 'prod',
			fixedIn: '1.2.6',
			fixType: 'patch',
			fixWithinRange: false,
		},
	]);
	void advisories;

	await dependencyStatus.replaceForScan(project.id, scan.id, new Date(), [
		{
			workspace: '',
			packageName: 'lodash',
			currentVersion: '4.17.15',
			declaredRange: '^4.17.15',
			wantedVersion: '4.17.21',
			latestVersion: '4.17.21',
			isDirect: true,
			depType: 'prod',
			updateKind: 'patch',
			deprecatedMessage: null,
		},
		{
			workspace: '',
			packageName: 'minimist',
			currentVersion: '1.2.0',
			declaredRange: '1.2.0',
			wantedVersion: '1.2.8',
			latestVersion: '1.2.8',
			isDirect: true,
			depType: 'prod',
			updateKind: 'patch',
			deprecatedMessage: null,
		},
		{
			workspace: '',
			packageName: 'wildcard-dep',
			currentVersion: '1.0.0',
			declaredRange: '*',
			wantedVersion: '1.2.0',
			latestVersion: '1.2.0',
			isDirect: true,
			depType: 'prod',
			updateKind: 'minor',
			deprecatedMessage: null,
		},
		{
			workspace: '',
			packageName: 'linked-dep',
			currentVersion: '0.1.0',
			declaredRange: 'workspace:*',
			wantedVersion: null,
			latestVersion: '0.2.0',
			isDirect: true,
			depType: 'prod',
			updateKind: 'minor',
			deprecatedMessage: null,
		},
		{
			workspace: '',
			packageName: 'left-pad',
			currentVersion: '1.3.0',
			declaredRange: '^1.3.0',
			wantedVersion: '1.3.0',
			latestVersion: '1.3.0',
			isDirect: true,
			depType: 'dev',
			updateKind: 'none',
			deprecatedMessage: null,
		},
	]);

	const harness = {
		db,
		stores: { projects, pullRequests },
		github,
		events,
		regenResult: { ok: false as boolean, reason: 'stubbed off' },
		regenCalls: 0,
		regenInputs: [] as LockfileRegenInput[],
		projectId: project.id,
	} as Harness;

	harness.service = createPrService({
		projects,
		scans,
		dependencySets,
		dependencyStatus,
		findings,
		pullRequests,
		github: {
			forToken() {
				const client = createGithubClient({
					apiUrl: GITHUB_URL,
					token: 'ghp_test',
					fetchImpl: github.fetch,
				});
				return { client, reader: createRepoReader(client) };
			},
			async resolveToken() {
				return 'ghp_test';
			},
		},
		async dispatchEvent(event) {
			events.push(event);
		},
		config: {
			enableLockfileRegen: options.enableLockfileRegen ?? true,
			appUrl: 'http://localhost:3000',
		},
		async regenerate(input) {
			harness.regenCalls += 1;
			harness.regenInputs.push(input);
			return harness.regenResult as
				| { ok: true; content: string }
				| { ok: false; reason: string };
		},
	});

	return harness;
}

/* -------------------------------------------------------------------------- */
/* Pure units                                                                 */
/* -------------------------------------------------------------------------- */

describe('branch naming', () => {
	test('is order-independent and content-addressed', () => {
		const a = branchNameFor('security', [
			{ packageName: 'lodash', toVersion: '4.17.21' },
			{ packageName: 'minimist', toVersion: '1.2.6' },
		]);
		const b = branchNameFor('security', [
			{ packageName: 'minimist', toVersion: '1.2.6' },
			{ packageName: 'lodash', toVersion: '4.17.21' },
		]);
		expect(a).toBe(b);
		expect(a).toMatch(/^understory\/security-[0-9a-f]{8}$/);

		const different = branchNameFor('security', [
			{ packageName: 'lodash', toVersion: '4.17.20' },
			{ packageName: 'minimist', toVersion: '1.2.6' },
		]);
		expect(different).not.toBe(a);

		// The prefix is part of the identity, not decoration.
		expect(
			branchNameFor('update', [
				{ packageName: 'lodash', toVersion: '4.17.21' },
			])
		).toMatch(/^understory\/update-/);
	});
});

describe('manifest editing', () => {
	test('rewrites only the target range and keeps key order + indentation', () => {
		const result = applyRangeEdits(PACKAGE_JSON, [
			{ packageName: 'lodash', newRange: '^4.17.21' },
		]);
		expect(result.applied).toEqual(['lodash']);
		expect(result.content).toContain('"lodash": "^4.17.21"');
		expect(result.content).toContain('"minimist": "1.2.0"');
		// Indentation sniffed from the source, trailing newline preserved.
		expect(result.content).toContain('\n    "name": "fixture-app"');
		expect(result.content.endsWith('\n')).toBe(true);

		const keys = [...result.content.matchAll(/^ {8}"([^"]+)"/gm)].map(
			(match) => match[1]
		);
		expect(keys.slice(0, 4)).toEqual([
			'lodash',
			'minimist',
			'wildcard-dep',
			'linked-dep',
		]);
	});

	test('reports packages it could not find', () => {
		const result = applyRangeEdits(PACKAGE_JSON, [
			{ packageName: 'not-there', newRange: '^1.0.0' },
		]);
		expect(result.applied).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

describe('pr plan', () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeHarness();
	});

	test('classifies manifest edits, lockfile-only bumps and drops', async () => {
		const plan = await harness.service.plan(harness.projectId, [
			{ name: 'lodash' },
			{ name: 'wildcard-dep' },
			{ name: 'linked-dep' },
			{ name: 'left-pad' },
			{ name: 'ghost-dep' },
		]);

		const byName = new Map(
			plan.items.map((item) => [item.packageName, item])
		);

		// ^4.17.15 does not admit 4.17.21? It does — but the advisory's fixedIn
		// is inside the caret range, so this is the lockfile-only case.
		const lodash = byName.get('lodash');
		expect(lodash?.status).toBe('lockfileOnly');
		expect(lodash?.toVersion).toBe('4.17.21');
		expect(lodash?.advisories[0]?.advisoryId).toBe(GHSA);
		expect(lodash?.severity).toBe('high');

		// `*` admits everything: lockfile-only, never a manifest edit.
		expect(byName.get('wildcard-dep')?.status).toBe('lockfileOnly');

		// `workspace:*` is not ours to rewrite.
		const linked = byName.get('linked-dep');
		expect(linked?.status).toBe('dropped');
		expect(linked?.reason).toContain('workspace');

		// Already at latest.
		expect(byName.get('left-pad')?.status).toBe('dropped');

		// Not in the dependency set at all.
		expect(byName.get('ghost-dep')?.status).toBe('dropped');
		expect(byName.get('ghost-dep')?.reason).toContain('not present');
	});

	test('rewrites a range that does not admit the target (planBump)', async () => {
		const plan = await harness.service.plan(harness.projectId, [
			{ name: 'minimist' },
		]);
		const item = plan.items[0];
		expect(item?.status).toBe('changesManifest');
		expect(item?.fromRange).toBe('1.2.0');
		expect(item?.toVersion).toBe('1.2.6');
		// An exact pin stays an exact pin — planBump preserves the operator.
		expect(item?.newRange).toBe('1.2.6');
		expect(plan.manifestPaths).toEqual(['package.json']);
		expect(plan.branchKind).toBe('security');
		expect(plan.title).toContain('security update for minimist');
		expect(plan.body).toContain('GHSA-minimist');
	});

	test('an explicit toVersion beats the advisory fix and flags majors', async () => {
		const plan = await harness.service.plan(harness.projectId, [
			{ name: 'lodash', toVersion: '5.0.0' },
		]);
		const item = plan.items[0];
		expect(item?.toVersion).toBe('5.0.0');
		expect(item?.status).toBe('changesManifest');
		expect(item?.newRange).toBe('^5.0.0');
		expect(item?.updateKind).toBe('major');
		expect(plan.warnings.join(' ')).toContain('MAJOR');
	});

	test('lockfile-only selections are dropped when regeneration is off', async () => {
		const off = await makeHarness({ enableLockfileRegen: false });
		const plan = await off.service.plan(off.projectId, [
			{ name: 'lodash' },
		]);
		expect(plan.items[0]?.status).toBe('dropped');
		expect(plan.items[0]?.reason).toContain('disabled');
		expect(plan.lockfileRegenPlanned).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */
/* Creation                                                                   */
/* -------------------------------------------------------------------------- */

describe('pr create', () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeHarness();
	});

	test('walks the Git Data sequence and commits the edited manifest', async () => {
		harness.regenResult = { ok: false, reason: 'npm is not available' };

		const created = await harness.service.create(
			harness.projectId,
			[{ name: 'minimist' }],
			{ kind: 'manual', actorUserId: 'user-1' }
		);

		expect(created.number).toBe(42);
		expect(created.url).toBe('https://github.com/acme/fixture-app/pull/42');
		expect(created.lockfileUpdated).toBe(false);

		expect(harness.github.writes()).toEqual([
			'GET /repos/acme/fixture-app/git/ref/heads/main',
			'POST /repos/acme/fixture-app/git/refs',
			'GET /repos/acme/fixture-app/git/commits/base-sha',
			'POST /repos/acme/fixture-app/git/blobs',
			'POST /repos/acme/fixture-app/git/trees',
			'POST /repos/acme/fixture-app/git/commits',
			`PATCH /repos/acme/fixture-app/git/refs/heads/${created.branch}`,
			'POST /repos/acme/fixture-app/pulls',
		]);

		// The single blob IS the rewritten package.json.
		expect(harness.github.script.blobs).toHaveLength(1);
		const committed = harness.github.script.blobs[0] as string;
		expect(committed).toContain('"minimist": "1.2.6"');
		expect(committed).toContain('"lodash": "^4.17.15"');

		// The tree points at the blob we just posted, at the right path.
		const tree = harness.github.script.calls.find(
			(call) => call.method === 'POST' && call.path.endsWith('/git/trees')
		);
		expect(tree?.body).toMatchObject({
			base_tree: 'base-tree-sha',
			tree: [
				{
					path: 'package.json',
					mode: '100644',
					type: 'blob',
					sha: 'blob-1',
				},
			],
		});

		// Row + bumps landed, and the notification fired exactly once.
		const rows = await harness.stores.pullRequests.listForProject(
			harness.projectId,
			{ page: 1, pageSize: 10 }
		);
		expect(rows.items).toHaveLength(1);
		expect(rows.items[0]?.pullRequest.state).toBe('open');
		expect(rows.items[0]?.pullRequest.commitSha).toBe('new-commit-sha');
		expect(rows.items[0]?.bumps[0]).toMatchObject({
			packageName: 'minimist',
			fromRange: '1.2.0',
			toVersion: '1.2.6',
			advisoryId: 'GHSA-minimist',
		});
		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]?.type).toBe('pr_opened');
		expect(harness.events[0]?.bumps[0]?.packageName).toBe('minimist');
	});

	test('a successful lockfile regeneration adds a second blob', async () => {
		harness.regenResult = { ok: true, content: '{"regenerated": true}' };

		const created = await harness.service.create(
			harness.projectId,
			[{ name: 'minimist' }],
			{ kind: 'manual' }
		);

		expect(harness.regenCalls).toBe(1);
		expect(created.lockfileUpdated).toBe(true);
		expect(harness.github.script.blobs).toHaveLength(2);
		expect(harness.github.script.blobs[1]).toBe('{"regenerated": true}');

		const tree = harness.github.script.calls.find(
			(call) => call.method === 'POST' && call.path.endsWith('/git/trees')
		);
		expect(
			(tree?.body?.tree as { path: string }[]).map((file) => file.path)
		).toEqual(['package.json', 'package-lock.json']);

		const pull = harness.github.script.calls.find(
			(call) => call.method === 'POST' && call.path.endsWith('/pulls')
		);
		expect(String(pull?.body?.body)).toContain('lockfile was regenerated');
	});

	test('a failed attempt does not wedge the branch: retry reclaims the row', async () => {
		// Lockfile-only bump whose regen fails → "no file changes" → row failed.
		harness.regenResult = { ok: false, reason: 'stub failure' };
		await expect(
			harness.service.create(
				harness.projectId,
				[{ name: 'wildcard-dep', toVersion: '1.2.0' }],
				{ kind: 'manual' }
			)
		).rejects.toThrow(InvalidInputError);

		const failed = await harness.stores.pullRequests.listForProject(
			harness.projectId,
			{ page: 1, pageSize: 10 }
		);
		expect(failed.items[0]?.pullRequest.state).toBe('failed');

		// Same selection, same deterministic branch — the retry must reclaim
		// the failed row instead of reporting "already being created".
		harness.regenResult = { ok: true, content: '{"regenerated": true}' };
		const created = await harness.service.create(
			harness.projectId,
			[{ name: 'wildcard-dep', toVersion: '1.2.0' }],
			{ kind: 'manual' }
		);
		expect(created.number).toBe(42);
		expect(created.lockfileUpdated).toBe(true);

		// One row total: the tombstone was revived, not duplicated.
		const rows = await harness.stores.pullRequests.listForProject(
			harness.projectId,
			{ page: 1, pageSize: 10 }
		);
		expect(rows.items).toHaveLength(1);
		expect(rows.items[0]?.pullRequest.state).toBe('open');
		expect(rows.items[0]?.pullRequest.errorMessage).toBeNull();
	});

	test('a covered second request 409s without touching GitHub', async () => {
		harness.regenResult = { ok: false, reason: 'off' };
		await harness.service.create(
			harness.projectId,
			[{ name: 'minimist' }],
			{
				kind: 'manual',
			}
		);
		const writesAfterFirst = harness.github.writes().length;

		// Same version, and a lower one: both are already covered.
		for (const toVersion of [undefined, '1.2.5']) {
			const attempt = harness.service.create(
				harness.projectId,
				[
					{
						name: 'minimist',
						...(toVersion === undefined ? {} : { toVersion }),
					},
				],
				{ kind: 'manual' }
			);
			await expect(attempt).rejects.toBeInstanceOf(PrAlreadyOpenError);
		}
		expect(harness.github.writes()).toHaveLength(writesAfterFirst);

		const rows = await harness.stores.pullRequests.listForProject(
			harness.projectId,
			{ page: 1, pageSize: 10 }
		);
		expect(rows.items).toHaveLength(1);
	});

	test('a selection where everything is dropped is a 422, not an empty PR', async () => {
		const attempt = harness.service.create(
			harness.projectId,
			[{ name: 'linked-dep' }],
			{ kind: 'manual' }
		);
		await expect(attempt).rejects.toBeInstanceOf(InvalidInputError);
		expect(harness.github.writes()).toHaveLength(0);
	});

	test('converges when the branch and the pull request already exist', async () => {
		harness.regenResult = { ok: false, reason: 'off' };
		harness.github.script.branchExists = true;
		harness.github.script.pullExists = true;

		const created = await harness.service.create(
			harness.projectId,
			[{ name: 'minimist' }],
			{ kind: 'manual' }
		);

		expect(created.number).toBe(42);
		const writes = harness.github.writes();
		// The 422 on POST /git/refs was absorbed…
		expect(writes).toContain('POST /repos/acme/fixture-app/git/refs');
		// …and the 422 on POST /pulls was answered by a lookup.
		expect(writes.filter((call) => call.endsWith('/pulls'))).toEqual([
			'POST /repos/acme/fixture-app/pulls',
			'GET /repos/acme/fixture-app/pulls',
		]);
	});

	test('a GitHub failure leaves the row in `failed` with the reason', async () => {
		harness.regenResult = { ok: false, reason: 'off' };
		harness.github.script.packageJson = '{ this is not json';

		await expect(
			harness.service.create(harness.projectId, [{ name: 'minimist' }], {
				kind: 'manual',
			})
		).rejects.toThrow();

		const rows = await harness.stores.pullRequests.listForProject(
			harness.projectId,
			{ page: 1, pageSize: 10 }
		);
		expect(rows.items[0]?.pullRequest.state).toBe('failed');
		expect(rows.items[0]?.pullRequest.errorMessage).not.toBeNull();
	});
});

/* -------------------------------------------------------------------------- */
/* Sync                                                                       */
/* -------------------------------------------------------------------------- */

describe('pr sync', () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeHarness();
		harness.regenResult = { ok: false, reason: 'off' };
	});

	test('merged PRs transition and emit pr_merged exactly once', async () => {
		await harness.service.create(
			harness.projectId,
			[{ name: 'minimist' }],
			{
				kind: 'manual',
			}
		);
		harness.events.length = 0;

		harness.github.script.pullState = {
			state: 'closed',
			merged: true,
			merged_at: '2026-01-02T03:04:05Z',
			closed_at: '2026-01-02T03:04:05Z',
		};

		const first = await harness.service.syncOpen();
		expect(first).toEqual({ checked: 1, transitioned: 1 });

		const rows = await harness.stores.pullRequests.listForProject(
			harness.projectId,
			{ page: 1, pageSize: 10 }
		);
		expect(rows.items[0]?.pullRequest.state).toBe('merged');
		expect(rows.items[0]?.pullRequest.mergedAt).toEqual(
			new Date('2026-01-02T03:04:05Z')
		);
		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]?.type).toBe('pr_merged');

		// A second tick has nothing left in flight.
		expect(await harness.service.syncOpen()).toEqual({
			checked: 0,
			transitioned: 0,
		});
	});

	test('a closed-unmerged PR becomes `closed` and emits nothing', async () => {
		await harness.service.create(
			harness.projectId,
			[{ name: 'minimist' }],
			{
				kind: 'manual',
			}
		);
		harness.events.length = 0;

		harness.github.script.pullState = {
			state: 'closed',
			merged: false,
			merged_at: null,
			closed_at: '2026-01-02T03:04:05Z',
		};

		expect(await harness.service.syncOpen()).toEqual({
			checked: 1,
			transitioned: 1,
		});
		const rows = await harness.stores.pullRequests.listForProject(
			harness.projectId,
			{ page: 1, pageSize: 10 }
		);
		expect(rows.items[0]?.pullRequest.state).toBe('closed');
		expect(harness.events).toHaveLength(0);
	});

	test('a `creating` row that never got a number is buried after 15 minutes', async () => {
		const stale = await harness.stores.pullRequests.createPending({
			projectId: harness.projectId,
			branch: 'understory/update-deadbeef',
			baseBranch: 'main',
			kind: 'manual',
			title: 'stuck',
			bumps: [],
		});
		harness.db
			.update(schema.pullRequests)
			.set({ createdAt: new Date(Date.now() - 20 * 60_000) })
			.where(eq(schema.pullRequests.id, stale?.id as string))
			.run();

		const result = await harness.service.syncOpen();
		expect(result.transitioned).toBe(1);
		const row = await harness.stores.pullRequests.byId(stale?.id as string);
		expect(row?.state).toBe('failed');
	});
});

/* -------------------------------------------------------------------------- */
/* Auto-PR port                                                               */
/* -------------------------------------------------------------------------- */

describe('auto PR port', () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeHarness();
		harness.regenResult = { ok: false, reason: 'off' };
	});

	test('groups duplicate selections at the highest version and never throws', async () => {
		await harness.service.autoPr.maybeCreate({
			projectId: harness.projectId,
			scanId: 'scan-1',
			selections: [
				{
					packageName: 'minimist',
					workspace: '',
					toVersion: '1.2.3',
					fixType: 'patch',
					advisoryId: 'GHSA-minimist',
					findingId: 'finding-1',
					severity: 'high',
				},
				{
					packageName: 'minimist',
					workspace: '',
					toVersion: '1.2.6',
					fixType: 'patch',
					advisoryId: 'GHSA-minimist',
					findingId: 'finding-2',
					severity: 'high',
				},
				{
					packageName: 'lodash',
					workspace: '',
					toVersion: '4.17.21',
					fixType: 'patch',
					advisoryId: GHSA,
					findingId: 'finding-3',
					severity: 'high',
				},
			],
		});

		const rows = await harness.stores.pullRequests.listForProject(
			harness.projectId,
			{ page: 1, pageSize: 10 }
		);
		expect(rows.items).toHaveLength(1);
		expect(rows.items[0]?.pullRequest.kind).toBe('auto_security');

		const bumps = rows.items[0]?.bumps ?? [];
		expect(bumps).toHaveLength(2);
		const minimist = bumps.find((bump) => bump.packageName === 'minimist');
		expect(minimist?.toVersion).toBe('1.2.6');

		// Second scan, same findings: the dedupe path swallows the conflict.
		const writesBefore = harness.github.writes().length;
		await harness.service.autoPr.maybeCreate({
			projectId: harness.projectId,
			scanId: 'scan-2',
			selections: [
				{
					packageName: 'minimist',
					workspace: '',
					toVersion: '1.2.6',
					fixType: 'patch',
					advisoryId: 'GHSA-minimist',
					findingId: 'finding-2',
					severity: 'high',
				},
				{
					packageName: 'lodash',
					workspace: '',
					toVersion: '4.17.21',
					fixType: 'patch',
					advisoryId: GHSA,
					findingId: 'finding-3',
					severity: 'high',
				},
			],
		});
		expect(harness.github.writes()).toHaveLength(writesBefore);
		const after = await harness.stores.pullRequests.listForProject(
			harness.projectId,
			{ page: 1, pageSize: 10 }
		);
		expect(after.items).toHaveLength(1);
	});
});

/* -------------------------------------------------------------------------- */
/* Catalog monorepo                                                           */
/* -------------------------------------------------------------------------- */

describe('catalog: ranges', () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeHarness({ files: CATALOG_FILES });
	});

	test('a bump beyond the catalog value edits the ROOT catalog entry', async () => {
		harness.regenResult = { ok: false, reason: 'bun is not available' };

		const plan = await harness.service.plan(harness.projectId, [
			{ name: 'react', toVersion: '20.1.0' },
		]);
		const item = plan.items[0];
		expect(item?.status).toBe('changesManifest');
		expect(item?.workspace).toBe('apps/web');
		// The workspace manifest says `catalog:frontend`; the edit belongs in
		// the root manifest that answers it.
		expect(item?.manifestPath).toBe('package.json');
		expect(item?.fromRange).toBe('^19.2.0');
		expect(item?.newRange).toBe('^20.1.0');
		expect(plan.manifestPaths).toEqual(['package.json']);
		// Workspaces used to veto regeneration outright.
		expect(plan.lockfileRegenPlanned).toBe(true);
		expect(plan.warnings.join(' ')).toContain('catalog:frontend');

		await harness.service.create(
			harness.projectId,
			[{ name: 'react', toVersion: '20.1.0' }],
			{ kind: 'manual' }
		);

		expect(harness.github.script.blobs).toHaveLength(1);
		const committed = harness.github.script.blobs[0] as string;
		expect(committed).toContain('"react": "^20.1.0"');
		// The other catalog and the workspace pointer are untouched.
		expect(committed).toContain('"left-pad": "^1.3.0"');
		expect(committed).not.toContain('catalog:');

		const tree = harness.github.script.calls.find(
			(call) => call.method === 'POST' && call.path.endsWith('/git/trees')
		);
		expect(
			(tree?.body?.tree as { path: string }[]).map((file) => file.path)
		).toEqual(['package.json']);
	});

	test('a catalog value that already admits the target is lockfile-only', async () => {
		harness.regenResult = {
			ok: true,
			content: '{"regenerated":"bun.lock"}',
		};

		const plan = await harness.service.plan(harness.projectId, [
			{ name: 'left-pad', toVersion: '1.3.5' },
		]);
		expect(plan.items[0]?.status).toBe('lockfileOnly');
		expect(plan.items[0]?.fromRange).toBe('^1.3.0');
		expect(plan.manifestPaths).toEqual([]);

		const created = await harness.service.create(
			harness.projectId,
			[{ name: 'left-pad', toVersion: '1.3.5' }],
			{ kind: 'manual' }
		);
		expect(created.lockfileUpdated).toBe(true);

		// Regeneration is asked for a TARGETED update — an install-mode refresh
		// would preserve the locked 1.3.0 and change nothing.
		const input = harness.regenInputs[0];
		expect(input?.manager).toBe('bun');
		expect(input?.updateTargets).toEqual(['left-pad']);
		expect(input?.lockfile.path).toBe('bun.lock');
		expect(
			input?.manifests.map((manifest) => manifest.path).sort()
		).toEqual(['apps/web/package.json', 'package.json']);

		// Only the lockfile is committed.
		expect(harness.github.script.blobs).toEqual([
			'{"regenerated":"bun.lock"}',
		]);
	});

	test('a manifest-only change asks for an install-mode refresh', async () => {
		harness.regenResult = {
			ok: true,
			content: '{"regenerated":"bun.lock"}',
		};

		await harness.service.create(
			harness.projectId,
			[{ name: 'react', toVersion: '20.1.0' }],
			{ kind: 'manual' }
		);

		const input = harness.regenInputs[0];
		expect(input?.updateTargets).toEqual([]);
		// The sandbox gets the EDITED root plus every other workspace manifest.
		const root = input?.manifests.find(
			(manifest) => manifest.path === 'package.json'
		);
		expect(root?.content).toContain('"react": "^20.1.0"');
		expect(
			input?.manifests.find(
				(manifest) => manifest.path === 'apps/web/package.json'
			)?.content
		).toContain('catalog:frontend');
	});

	test('with regeneration off a lockfile-only bump is dropped at preview time', async () => {
		const off = await makeHarness({
			files: CATALOG_FILES,
			enableLockfileRegen: false,
		});

		const plan = await off.service.plan(off.projectId, [
			{ name: 'left-pad', toVersion: '1.3.5' },
		]);
		expect(plan.items[0]?.status).toBe('dropped');
		expect(plan.items[0]?.reason).toContain(
			'requires lockfile regeneration, which is disabled'
		);
		expect(plan.includedCount).toBe(0);

		await expect(
			off.service.create(
				off.projectId,
				[{ name: 'left-pad', toVersion: '1.3.5' }],
				{ kind: 'manual' }
			)
		).rejects.toBeInstanceOf(InvalidInputError);
		expect(off.github.writes()).toHaveLength(0);
	});

	test('an empty change set names the reason instead of dead-ending', async () => {
		harness.regenResult = {
			ok: false,
			reason: 'update produced no lockfile change (targets may be pinned by catalog: or exact versions)',
		};

		let caught: unknown;
		try {
			await harness.service.create(
				harness.projectId,
				[{ name: 'left-pad', toVersion: '1.3.5' }],
				{ kind: 'manual' }
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(InvalidInputError);
		const message = (caught as Error).message;
		expect(message).toContain('produce no file changes');
		expect(message).toContain('bun.lock');
		expect(message).toContain('update produced no lockfile change');
	});
});

/* -------------------------------------------------------------------------- */
/* Lockfile regeneration                                                      */
/* -------------------------------------------------------------------------- */

/** A `Bun.spawn` double: records each command and runs `onRun` in its cwd. */
function fakeSpawn(
	runs: { cmd: string[]; cwd: string }[],
	onRun?: (cwd: string, cmd: string[]) => Promise<void>
): typeof Bun.spawn {
	return ((options: { cmd: string[]; cwd: string }) => {
		runs.push({ cmd: options.cmd, cwd: options.cwd });
		return {
			exited: (
				onRun?.(options.cwd, options.cmd) ?? Promise.resolve()
			).then(() => 0),
			kill() {
				/* nothing to kill */
			},
			stderr: new Response('').body,
		};
	}) as unknown as typeof Bun.spawn;
}

describe('lockfile regeneration', () => {
	const WORKSPACE_MANIFESTS = [
		{
			path: 'package.json',
			content:
				'{"name":"root","workspaces":["apps/*"],"catalog":{"react":"^19.5.0"}}',
		},
		{
			path: 'apps/web/package.json',
			content: '{"name":"web","dependencies":{"react":"catalog:"}}',
		},
	];

	test('materialises every workspace manifest and updates, then refreshes', async () => {
		const runs: { cmd: string[]; cwd: string }[] = [];
		const seen: string[] = [];

		const result = await regenerateLockfile({
			manager: 'bun',
			manifests: WORKSPACE_MANIFESTS,
			lockfile: { path: 'bun.lock', content: '{"old":true}' },
			updateTargets: ['react'],
			spawn: fakeSpawn(runs, async (cwd) => {
				seen.push(
					await readFile(join(cwd, 'apps/web/package.json'), 'utf8')
				);
				await writeFile(join(cwd, 'bun.lock'), '{"new":true}');
			}),
		});

		expect(result.ok).toBe(true);
		expect(result.ok && result.content).toBe('{"new":true}');
		// Targeted update first, then an install-mode refresh that normalises
		// whatever `bun update` wrote back into the manifests.
		expect(runs.map((run) => run.cmd.slice(1))).toEqual([
			['update', '--lockfile-only', '--ignore-scripts', 'react'],
			['install', '--lockfile-only', '--ignore-scripts'],
		]);
		// The workspace manifest — invisible to the old implementation — is on
		// disk with its `catalog:` pointer intact.
		expect(seen[0]).toContain('catalog:');
	});

	test('without update targets it only refreshes', async () => {
		const runs: { cmd: string[]; cwd: string }[] = [];
		const result = await regenerateLockfile({
			manager: 'bun',
			manifests: WORKSPACE_MANIFESTS,
			lockfile: { path: 'bun.lock', content: '{"old":true}' },
			spawn: fakeSpawn(runs, async (cwd) => {
				await writeFile(join(cwd, 'bun.lock'), '{"new":true}');
			}),
		});

		expect(result.ok).toBe(true);
		expect(runs.map((run) => run.cmd.slice(1))).toEqual([
			['install', '--lockfile-only', '--ignore-scripts'],
		]);
	});

	test('npm gets install flags on its update command', async () => {
		const runs: { cmd: string[]; cwd: string }[] = [];
		await regenerateLockfile({
			manager: 'npm',
			manifests: [{ path: 'package.json', content: '{"name":"root"}' }],
			lockfile: { path: 'package-lock.json', content: '{"old":true}' },
			updateTargets: ['lodash', 'lodash'],
			spawn: fakeSpawn(runs, async (cwd) => {
				await writeFile(join(cwd, 'package-lock.json'), '{"new":true}');
			}),
		});

		expect(runs[0]?.cmd.slice(1)).toEqual([
			'update',
			'--package-lock-only',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			'--loglevel=error',
			'lodash',
		]);
	});

	test('an unchanged lockfile after a targeted update says so', async () => {
		const result = await regenerateLockfile({
			manager: 'bun',
			manifests: WORKSPACE_MANIFESTS,
			lockfile: { path: 'bun.lock', content: '{"old":true}' },
			updateTargets: ['react'],
			spawn: fakeSpawn([]),
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain(
			'update produced no lockfile change'
		);
	});

	test('refuses managers it cannot drive', async () => {
		const result = await regenerateLockfile({
			manager: 'pnpm',
			manifests: [{ path: 'package.json', content: '{}' }],
			lockfile: { path: 'pnpm-lock.yaml', content: '' },
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toContain('pnpm');
	});

	const npmAvailable = Bun.which('npm') !== null;
	const maybe = npmAvailable ? test : test.skip;

	maybe(
		'runs npm install --package-lock-only in a sandbox',
		async () => {
			const result = await regenerateLockfile({
				manager: 'npm',
				manifests: [
					{
						path: 'package.json',
						content: `${JSON.stringify(
							{
								name: 'regen-fixture',
								version: '1.0.0',
								private: true,
								dependencies: {},
							},
							null,
							2
						)}\n`,
					},
				],
				lockfile: {
					path: 'package-lock.json',
					content: '{\n  "lockfileVersion": 3\n}\n',
				},
				timeoutMs: 60_000,
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				const parsed = JSON.parse(result.content) as {
					name?: string;
					lockfileVersion?: number;
				};
				expect(parsed.name).toBe('regen-fixture');
				expect(parsed.lockfileVersion).toBe(3);
			}
		},
		90_000
	);

	const bunPath = Bun.which('bun');
	const maybeBun = bunPath === null ? test.skip : test;

	/**
	 * The end-to-end proof of the bug, against a real bun workspace monorepo
	 * and the real registry. NEEDS NETWORK: `is-odd` is resolved for real. When
	 * the seeding install cannot reach the registry the test returns early
	 * rather than failing a offline run.
	 */
	maybeBun(
		'forces an in-range catalog bump in a real bun monorepo',
		async () => {
			const directory = await mkdtemp(
				join(tmpdir(), 'understory-regen-fixture-')
			);
			try {
				const app = {
					name: 'regen-app',
					version: '1.0.0',
					dependencies: { 'is-odd': 'catalog:' },
				};
				await mkdir(join(directory, 'packages/app'), {
					recursive: true,
				});
				await writeFile(
					join(directory, 'package.json'),
					JSON.stringify(
						{
							name: 'regen-root',
							private: true,
							workspaces: ['packages/*'],
							// Pinned, so the seed lockfile is stuck on 3.0.0
							// while 3.0.1 exists.
							catalog: { 'is-odd': '3.0.0' },
						},
						null,
						2
					)
				);
				await writeFile(
					join(directory, 'packages/app/package.json'),
					JSON.stringify(app, null, 2)
				);

				const seed = Bun.spawn({
					cmd: [
						bunPath as string,
						'install',
						'--lockfile-only',
						'--ignore-scripts',
					],
					cwd: directory,
					stdout: 'pipe',
					stderr: 'pipe',
				});
				if ((await seed.exited) !== 0) return; // offline: nothing to prove

				const seeded = await readFile(
					join(directory, 'bun.lock'),
					'utf8'
				);
				expect(seeded).toContain('is-odd@3.0.0');

				const result = await regenerateLockfile({
					manager: 'bun',
					manifests: [
						{
							path: 'package.json',
							content: JSON.stringify(
								{
									name: 'regen-root',
									private: true,
									workspaces: ['packages/*'],
									catalog: { 'is-odd': '^3.0.0' },
								},
								null,
								2
							),
						},
						{
							path: 'packages/app/package.json',
							content: JSON.stringify(app, null, 2),
						},
					],
					lockfile: { path: 'bun.lock', content: seeded },
					updateTargets: ['is-odd'],
					timeoutMs: 90_000,
				});

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.content).toContain('is-odd@3.0.1');
					// `bun update <name>` adds the target to the manifest it
					// runs from; the refresh pass scrubs that phantom root
					// dependency back out of the lockfile.
					expect(result.content).toContain('"is-odd": "catalog:"');
					expect(result.content).not.toContain('"is-odd": "^3.0.1"');
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		120_000
	);
});

/* -------------------------------------------------------------------------- */
/* Python fixtures                                                            */
/* -------------------------------------------------------------------------- */

const GHSA_PY = 'GHSA-x84v-xcm2-53pg';

const UV_PYPROJECT = `[project]
name = "fixture-py"
version = "0.1.0"
dependencies = [
    "requests==2.19.0",
    "urllib3>=1.20",
]
`;

const UV_LOCK_FILE = `version = 1

[[package]]
name = "fixture-py"
version = "0.1.0"
source = { virtual = "." }
dependencies = [{ name = "requests" }, { name = "urllib3" }]

[[package]]
name = "requests"
version = "2.19.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [{ name = "urllib3" }]

[[package]]
name = "urllib3"
version = "1.23"
source = { registry = "https://pypi.org/simple" }
`;

const POETRY_PYPROJECT = `[tool.poetry]
name = "fixture-poetry"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
requests = "2.19.0"
`;

const POETRY_LOCK_FILE = `[[package]]
name = "requests"
version = "2.19.0"
category = "main"
optional = false
`;

const REQUIREMENTS_TXT = `# api clients
requests==2.19.0  # pinned for reproducibility
`;

const UV_FILES: Record<string, string> = {
	'pyproject.toml': UV_PYPROJECT,
	'uv.lock': UV_LOCK_FILE,
};

const POETRY_FILES: Record<string, string> = {
	'pyproject.toml': POETRY_PYPROJECT,
	'poetry.lock': POETRY_LOCK_FILE,
};

const PIP_FILES: Record<string, string> = {
	'requirements.txt': REQUIREMENTS_TXT,
};

/**
 * Lean python variant of {@link makeHarness}: same GitHub double and regen
 * stub, but the scan snapshot comes from `parsePypi` and the seeded finding
 * targets `requests`.
 */
async function makePypiHarness(
	files: Record<string, string>
): Promise<Harness> {
	const { db } = createDb(':memory:');
	runMigrations(db);
	db.insert(schema.appSettings)
		.values({ id: 1, createdAt: new Date(), updatedAt: new Date() })
		.run();

	const github = makeGithub(files);
	const events: (PrOpenedEvent | PrMergedEvent)[] = [];

	const projects = createProjectsStore(db);
	const scans = createScansStore(db);
	const dependencySets = createDependencySetsStore(db);
	const dependencyStatus = createDependencyStatusStore(db);
	const findings = createFindingsStore(db);
	const pullRequests = createPullRequestsStore(db);

	const project = await projects.create({
		name: 'fixture-py',
		owner: 'acme',
		repo: 'fixture-py',
		branch: 'main',
	});

	const scan = await scans.begin({
		projectId: project.id,
		trigger: 'manual',
	});
	const graph = parsePypi(
		Object.entries(files).map(([path, content]) => ({ path, content }))
	);
	const setRow = await dependencySets.create({
		projectId: project.id,
		lockHash: 'hash-py-1',
		manager: graph.manager,
		graph,
		firstScanId: scan.id,
	});
	await scans.succeed(scan.id, {
		commitSha: 'base-sha',
		branch: 'main',
		dependencySetId: setRow.id,
		lockHash: 'hash-py-1',
		depsReused: false,
		counters: {
			totalDeps: graph.dependencies.length,
			directDeps: graph.dependencies.filter((d) => d.isDirect).length,
			peerDeps: 0,
			vulnCritical: 0,
			vulnHigh: 0,
			vulnModerate: 1,
			vulnLow: 0,
			outdatedCount: 1,
			majorOutdatedCount: 0,
			newFindings: 1,
			resolvedFindings: 0,
		},
	});
	await projects.finishScan(project.id, {
		scanId: scan.id,
		success: true,
		lockHash: 'hash-py-1',
		nextScanAt: new Date(Date.now() + 3_600_000),
	});

	db.insert(schema.advisories)
		.values({
			id: GHSA_PY,
			summary: 'requests leaks Authorization headers on redirect',
			severity: 'moderate',
			url: `https://github.com/advisories/${GHSA_PY}`,
			updatedAt: new Date(),
		})
		.run();
	await findings.syncForScan(project.id, scan.id, new Date(), [
		{
			advisoryId: GHSA_PY,
			packageName: 'requests',
			packageVersion: '2.19.0',
			workspace: '',
			severity: 'moderate',
			isDirect: true,
			depType: 'prod',
			fixedIn: '2.20.0',
			fixType: 'minor',
			fixWithinRange: false,
		},
	]);

	await dependencyStatus.replaceForScan(project.id, scan.id, new Date(), [
		{
			workspace: '',
			packageName: 'requests',
			currentVersion: '2.19.0',
			declaredRange: '==2.19.0',
			wantedVersion: '2.19.0',
			latestVersion: '2.32.3',
			isDirect: true,
			depType: 'prod',
			updateKind: 'minor',
			deprecatedMessage: null,
		},
		{
			workspace: '',
			packageName: 'urllib3',
			currentVersion: '1.23',
			declaredRange: '>=1.20',
			wantedVersion: '2.2.2',
			latestVersion: '2.2.2',
			isDirect: true,
			depType: 'prod',
			updateKind: 'major',
			deprecatedMessage: null,
		},
	]);

	const harness = {
		db,
		stores: { projects, pullRequests },
		github,
		events,
		regenResult: { ok: false as boolean, reason: 'stubbed off' },
		regenCalls: 0,
		regenInputs: [] as LockfileRegenInput[],
		projectId: project.id,
	} as Harness;

	harness.service = createPrService({
		projects,
		scans,
		dependencySets,
		dependencyStatus,
		findings,
		pullRequests,
		github: {
			forToken() {
				const client = createGithubClient({
					apiUrl: GITHUB_URL,
					token: 'ghp_test',
					fetchImpl: github.fetch,
				});
				return { client, reader: createRepoReader(client) };
			},
			async resolveToken() {
				return 'ghp_test';
			},
		},
		async dispatchEvent(event) {
			events.push(event);
		},
		config: {
			enableLockfileRegen: true,
			appUrl: 'http://localhost:3000',
		},
		async regenerate(input) {
			harness.regenCalls += 1;
			harness.regenInputs.push(input);
			return harness.regenResult as
				| { ok: true; content: string }
				| { ok: false; reason: string };
		},
	});

	return harness;
}

/* -------------------------------------------------------------------------- */
/* Python pull requests                                                       */
/* -------------------------------------------------------------------------- */

describe('pypi pull requests', () => {
	test('uv plan: pin rewrite + in-range bump classified per PEP 440', async () => {
		const harness = await makePypiHarness(UV_FILES);
		const plan = await harness.service.plan(harness.projectId, [
			{ name: 'requests' },
			{ name: 'urllib3', toVersion: '2.2.2' },
		]);

		const requests = plan.items.find(
			(item) => item.packageName === 'requests'
		);
		expect(requests?.status).toBe('changesManifest');
		expect(requests?.toVersion).toBe('2.20.0');
		expect(requests?.newRange).toBe('==2.20.0');
		expect(requests?.manifestPath).toBe('pyproject.toml');
		expect(requests?.advisories[0]?.advisoryId).toBe(GHSA_PY);

		// `>=1.20` already admits 2.2.2 → only uv.lock moves.
		const urllib3 = plan.items.find(
			(item) => item.packageName === 'urllib3'
		);
		expect(urllib3?.status).toBe('lockfileOnly');

		expect(plan.branchKind).toBe('security');
		expect(plan.lockfileRegenPlanned).toBe(true);
	});

	test('uv create: commits the edited pyproject and the regenerated uv.lock', async () => {
		const harness = await makePypiHarness(UV_FILES);
		harness.regenResult = {
			ok: true,
			content: 'version = 2 # regenerated',
		};

		const created = await harness.service.create(
			harness.projectId,
			[{ name: 'requests' }, { name: 'urllib3', toVersion: '2.2.2' }],
			{ kind: 'manual' }
		);

		expect(created.lockfileUpdated).toBe(true);
		expect(harness.regenCalls).toBe(1);
		expect(harness.regenInputs[0]?.manager).toBe('uv');
		expect(harness.regenInputs[0]?.updateTargets).toEqual(['urllib3']);
		expect(harness.regenInputs[0]?.lockfile.path).toBe('uv.lock');
		expect(
			harness.regenInputs[0]?.manifests.map((file) => file.path)
		).toEqual(['pyproject.toml']);

		const blobs = harness.github.script.blobs;
		expect(blobs).toHaveLength(2);
		expect(blobs[0]).toContain('"requests==2.20.0"');
		expect(blobs[0]).toContain('"urllib3>=1.20"');
		expect(blobs[1]).toBe('version = 2 # regenerated');

		const pull = harness.github.script.calls.find(
			(call) => call.method === 'POST' && call.path.endsWith('/pulls')
		);
		expect(String(pull?.body?.body)).toContain('lockfile was regenerated');
	});

	test('poetry plan: rewrites the range in poetry syntax', async () => {
		const harness = await makePypiHarness(POETRY_FILES);
		const plan = await harness.service.plan(harness.projectId, [
			{ name: 'requests' },
		]);

		const requests = plan.items.find(
			(item) => item.packageName === 'requests'
		);
		expect(requests?.status).toBe('changesManifest');
		expect(requests?.newRange).toBe('2.20.0');
		expect(requests?.manifestPath).toBe('pyproject.toml');
	});

	test('pip create: edits requirements.txt pins directly, no lockfile talk', async () => {
		const harness = await makePypiHarness(PIP_FILES);

		const created = await harness.service.create(
			harness.projectId,
			[{ name: 'requests' }],
			{ kind: 'manual' }
		);

		expect(created.lockfileUpdated).toBe(false);
		expect(harness.regenCalls).toBe(0);

		const blobs = harness.github.script.blobs;
		expect(blobs).toHaveLength(1);
		expect(blobs[0]).toContain('requests==2.20.0');
		expect(blobs[0]).toContain('# pinned for reproducibility');

		const pull = harness.github.script.calls.find(
			(call) => call.method === 'POST' && call.path.endsWith('/pulls')
		);
		expect(String(pull?.body?.body)).not.toContain('lockfile');
	});
});
