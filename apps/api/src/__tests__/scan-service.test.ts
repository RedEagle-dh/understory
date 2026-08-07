import { beforeEach, describe, expect, test } from 'bun:test';
import {
	createNpmClient,
	createOsvClient,
	createPypiClient,
} from '@workspace/audit-engine';
import { createDb, runMigrations, schema } from '@workspace/db';
import { createSecretBox } from '@workspace/db/crypto';
import { eq } from 'drizzle-orm';
import { createRegistryCachePort } from '../adapters/registry-cache-port';
import { ScanInProgressError } from '../errors';
import { buildScanDiff } from '../services/scan-diff';
import { createScanService } from '../services/scan-service';
import { createAdvisoriesStore } from '../stores/advisories';
import { createDependencySetsStore } from '../stores/dependency-sets';
import { createDependencyStatusStore } from '../stores/dependency-status';
import { createFindingsStore } from '../stores/findings';
import { createPeerIssuesStore } from '../stores/peer-issues';
import { createProjectsStore } from '../stores/projects';
import { createRegistryCacheStore } from '../stores/registry-cache';
import { createScansStore } from '../stores/scans';
import { createSettingsStore } from '../stores/settings';

/* -------------------------------------------------------------------------- */
/* Fixture repository                                                         */
/* -------------------------------------------------------------------------- */

const PACKAGE_JSON = JSON.stringify({
	name: 'fixture-app',
	version: '1.0.0',
	dependencies: { lodash: '^4.17.15' },
	devDependencies: { 'left-pad': '^1.3.0' },
});

function lockfile(lodashVersion: string): string {
	return JSON.stringify({
		name: 'fixture-app',
		version: '1.0.0',
		lockfileVersion: 3,
		requires: true,
		packages: {
			'': {
				name: 'fixture-app',
				version: '1.0.0',
				dependencies: { lodash: '^4.17.15' },
				devDependencies: { 'left-pad': '^1.3.0' },
			},
			'node_modules/lodash': {
				version: lodashVersion,
				resolved: `https://registry.npmjs.org/lodash/-/lodash-${lodashVersion}.tgz`,
				integrity: 'sha512-fixture',
			},
			'node_modules/left-pad': {
				version: '1.3.0',
				dev: true,
				resolved:
					'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
				integrity: 'sha512-fixture',
			},
		},
	});
}

const GHSA = 'GHSA-35jh-r3h4-6jhm';
const CVE = 'CVE-2021-23337';
const CVSS_VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H';

const NPM_BULK = {
	lodash: [
		{
			id: 1106913,
			url: `https://github.com/advisories/${GHSA}`,
			title: 'Command Injection in lodash',
			severity: 'high',
			vulnerable_versions: '<4.17.21',
			cwe: ['CWE-77'],
			cvss: { score: 7.2, vectorString: CVSS_VECTOR },
		},
	],
};

/** OSV reports the SAME vulnerability under its CVE id, aliased to the GHSA. */
const OSV_VULN = {
	id: CVE,
	aliases: [GHSA],
	summary: 'lodash is vulnerable to command injection',
	details:
		'lodash versions prior to 4.17.21 are vulnerable to command injection.',
	severity: [{ type: 'CVSS_V3', score: CVSS_VECTOR }],
	affected: [
		{
			package: { name: 'lodash', ecosystem: 'npm' },
			ranges: [
				{
					type: 'ECOSYSTEM',
					events: [{ introduced: '0' }, { fixed: '4.17.21' }],
				},
			],
		},
	],
	database_specific: { severity: 'HIGH', cwe_ids: ['CWE-77'] },
	published: '2021-02-15T11:15:00Z',
	modified: '2023-01-01T00:00:00Z',
};

const PACKUMENTS: Record<string, unknown> = {
	lodash: {
		name: 'lodash',
		'dist-tags': { latest: '4.17.21' },
		versions: {
			'4.17.15': { name: 'lodash', version: '4.17.15' },
			'4.17.20': { name: 'lodash', version: '4.17.20' },
			'4.17.21': { name: 'lodash', version: '4.17.21' },
		},
		// Consumed by the auto-bump cooldown via getPublishTimes.
		time: {
			created: '2012-04-23T16:37:11.912Z',
			modified: '2021-02-20T15:42:16.891Z',
			'4.17.15': '2019-07-19T02:28:46.584Z',
			'4.17.20': '2020-08-13T16:53:54.152Z',
			'4.17.21': '2021-02-20T15:42:16.891Z',
		},
	},
	'left-pad': {
		name: 'left-pad',
		'dist-tags': { latest: '1.3.0' },
		versions: { '1.3.0': { name: 'left-pad', version: '1.3.0' } },
		time: { '1.3.0': '2018-04-10T00:00:00.000Z' },
	},
};

const GITHUB_URL = 'https://api.github.com';
const REGISTRY_URL = 'https://registry.npmjs.org';
const OSV_URL = 'https://api.osv.dev';
const PYPI_URL = 'https://pypi.org';

/* -------------------------------------------------------------------------- */
/* Python fixture repository                                                  */
/* -------------------------------------------------------------------------- */

const PYPROJECT_TOML = `
[project]
name = "fixture-py"
version = "0.1.0"
dependencies = ["requests>=2.19"]
`;

const UV_LOCK = `
version = 1

[[package]]
name = "fixture-py"
version = "0.1.0"
source = { virtual = "." }
dependencies = [{ name = "requests" }]

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

const GHSA_PY = 'GHSA-x84v-xcm2-53pg';
const CVE_PY = 'CVE-2018-18074';

const OSV_PY_VULN = {
	id: GHSA_PY,
	aliases: [CVE_PY],
	summary: 'requests exposes Authorization header to redirect targets',
	affected: [
		{
			package: { name: 'requests', ecosystem: 'PyPI' },
			ranges: [
				{
					type: 'ECOSYSTEM',
					events: [{ introduced: '0' }, { fixed: '2.20.0' }],
				},
			],
		},
	],
	database_specific: { severity: 'MODERATE' },
	published: '2018-10-29T12:00:00Z',
	modified: '2023-06-01T00:00:00Z',
};

function pypiRelease(uploaded: string): { upload_time_iso_8601: string }[] {
	return [{ upload_time_iso_8601: uploaded }];
}

const PYPI_PROJECTS: Record<string, unknown> = {
	requests: {
		info: { name: 'requests', version: '2.32.3' },
		releases: {
			'2.19.0': pypiRelease('2018-06-14T00:00:00Z'),
			'2.20.0': pypiRelease('2018-10-18T00:00:00Z'),
			'2.32.3': pypiRelease('2024-05-29T00:00:00Z'),
		},
	},
	urllib3: {
		info: { name: 'urllib3', version: '2.2.2' },
		releases: {
			'1.23': pypiRelease('2018-06-05T00:00:00Z'),
			'2.2.2': pypiRelease('2024-06-17T00:00:00Z'),
		},
	},
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
	db: ReturnType<typeof createDb>['db'];
	service: ReturnType<typeof createScanService>;
	stores: {
		projects: ReturnType<typeof createProjectsStore>;
		scans: ReturnType<typeof createScansStore>;
		dependencySets: ReturnType<typeof createDependencySetsStore>;
		findings: ReturnType<typeof createFindingsStore>;
		dependencyStatus: ReturnType<typeof createDependencyStatusStore>;
		advisories: ReturnType<typeof createAdvisoriesStore>;
		peerIssues: ReturnType<typeof createPeerIssuesStore>;
	};
	state: {
		lodashVersion: string;
		commitSha: string;
		githubFails: boolean;
		/** Serve the Python fixture repo instead of the npm one. */
		pythonRepo: boolean;
		osvQueries: number;
		npmBulkCalls: number;
		bumpCalls: import('../services/ports').AutoBumpInput[];
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function makeHarness(): Harness {
	const { db } = createDb(':memory:');
	runMigrations(db);
	db.insert(schema.appSettings)
		.values({ id: 1, createdAt: new Date(), updatedAt: new Date() })
		.run();

	const state = {
		lodashVersion: '4.17.15',
		commitSha: 'sha-1',
		githubFails: false,
		pythonRepo: false,
		osvQueries: 0,
		npmBulkCalls: 0,
		bumpCalls: [] as import('../services/ports').AutoBumpInput[],
	};

	const fakeFetch = (async (
		input: unknown,
		init?: { body?: unknown }
	): Promise<Response> => {
		const url = typeof input === 'string' ? input : String(input);

		/* ------------------------------- GitHub ------------------------- */
		if (url.startsWith(GITHUB_URL)) {
			if (state.githubFails) {
				throw new TypeError('fetch failed: connection refused');
			}
			const path = url.slice(GITHUB_URL.length);
			if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
				return json({ default_branch: 'main' });
			}
			if (path.includes('/commits/'))
				return json({ sha: state.commitSha });
			if (path.includes('/git/trees/')) {
				return json({
					truncated: false,
					tree: state.pythonRepo
						? [
								{ path: 'pyproject.toml', type: 'blob' },
								{ path: 'uv.lock', type: 'blob' },
								{ path: 'README.md', type: 'blob' },
							]
						: [
								{ path: 'package.json', type: 'blob' },
								{ path: 'package-lock.json', type: 'blob' },
								{ path: 'README.md', type: 'blob' },
							],
				});
			}
			if (path.includes('/contents/package-lock.json')) {
				return new Response(lockfile(state.lodashVersion));
			}
			if (path.includes('/contents/package.json')) {
				return new Response(PACKAGE_JSON);
			}
			if (path.includes('/contents/pyproject.toml')) {
				return new Response(PYPROJECT_TOML);
			}
			if (path.includes('/contents/uv.lock')) {
				return new Response(UV_LOCK);
			}
			return json({ message: 'not found' }, 404);
		}

		/* ------------------------------- npm ---------------------------- */
		if (url.startsWith(REGISTRY_URL)) {
			const path = url.slice(REGISTRY_URL.length);
			if (path === '/-/npm/v1/security/advisories/bulk') {
				state.npmBulkCalls += 1;
				const requested = JSON.parse(
					String(init?.body ?? '{}')
				) as Record<string, string[]>;
				return json('lodash' in requested ? NPM_BULK : {});
			}
			const distTags = /^\/-\/package\/(.+)\/dist-tags$/.exec(path);
			if (distTags !== null) {
				const name = decodeURIComponent(
					(distTags[1] ?? '').replace(/%2f/gi, '/')
				);
				const packument = PACKUMENTS[name] as
					| { 'dist-tags': Record<string, string> }
					| undefined;
				return packument === undefined
					? json({}, 404)
					: json(packument['dist-tags']);
			}
			const name = decodeURIComponent(
				path.slice(1).replace(/%2f/gi, '/')
			);
			const packument = PACKUMENTS[name];
			return packument === undefined ? json({}, 404) : json(packument);
		}

		/* ------------------------------- OSV ---------------------------- */
		if (url.startsWith(OSV_URL)) {
			if (url.endsWith('/v1/querybatch')) {
				state.osvQueries += 1;
				const payload = JSON.parse(String(init?.body ?? '{}')) as {
					queries: {
						package: { name: string; ecosystem?: string };
						version: string;
					}[];
				};
				return json({
					results: payload.queries.map((query) => {
						if (
							query.package.ecosystem === 'PyPI' &&
							query.package.name === 'requests' &&
							query.version === '2.19.0'
						) {
							return {
								vulns: [
									{
										id: GHSA_PY,
										modified: OSV_PY_VULN.modified,
									},
								],
							};
						}
						return query.package.name === 'lodash' &&
							query.version !== '4.17.21'
							? {
									vulns: [
										{
											id: CVE,
											modified: OSV_VULN.modified,
										},
									],
								}
							: {};
					}),
				});
			}
			if (url.endsWith(`/v1/vulns/${CVE}`)) return json(OSV_VULN);
			if (url.endsWith(`/v1/vulns/${GHSA_PY}`)) return json(OSV_PY_VULN);
			return json({}, 404);
		}

		/* ------------------------------- PyPI --------------------------- */
		if (url.startsWith(PYPI_URL)) {
			const match = /^\/pypi\/([^/]+)\/json$/.exec(
				url.slice(PYPI_URL.length)
			);
			const project =
				match === null ? undefined : PYPI_PROJECTS[match[1] ?? ''];
			return project === undefined ? json({}, 404) : json(project);
		}

		throw new Error(`unexpected fetch: ${url}`);
	}) as unknown as typeof fetch;

	const registryCache = createRegistryCacheStore(db);
	const stores = {
		projects: createProjectsStore(db),
		scans: createScansStore(db),
		dependencySets: createDependencySetsStore(db),
		advisories: createAdvisoriesStore(db),
		findings: createFindingsStore(db),
		dependencyStatus: createDependencyStatusStore(db),
		peerIssues: createPeerIssuesStore(db),
	};

	const service = createScanService({
		...stores,
		settings: createSettingsStore(db),
		registryCache,
		npm: createNpmClient({
			fetch: fakeFetch,
			cache: createRegistryCachePort(registryCache),
			registryUrl: REGISTRY_URL,
		}),
		pypi: createPypiClient({
			fetch: fakeFetch,
			cache: createRegistryCachePort(registryCache),
		}),
		osv: createOsvClient({ fetch: fakeFetch, baseUrl: OSV_URL }),
		secretBox: createSecretBox({
			current: Buffer.from(
				crypto.getRandomValues(new Uint8Array(32))
			).toString('base64'),
		}),
		projectTokenAad: (projectId) => `project-token:${projectId}`,
		globalTokenAad: () => 'app-settings:github-default-token',
		config: {
			githubApiUrl: GITHUB_URL,
			githubToken: 'ghp_test',
			disableOsv: false,
		},
		notifier: { async scanDiff() {}, async scanFailed() {} },
		autoPr: {
			async maybeCreate() {},
			async maybeCreateBumps(input) {
				state.bumpCalls.push(input);
			},
		},
		fetchImpl: fakeFetch,
	});

	return { db, service, stores, state };
}

async function makeProject(harness: Harness) {
	return harness.stores.projects.create({
		name: 'fixture-app',
		owner: 'acme',
		repo: 'fixture-app',
		branch: '',
	});
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('scan service', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = makeHarness();
	});

	test('scan 1 creates findings, one merged advisory, and status rows', async () => {
		const project = await makeProject(harness);
		const result = await harness.service.runScan(project.id, 'manual');

		expect(result.status).toBe('ok');
		expect(result.depsReused).toBe(false);

		// One canonical advisory, contributed to by BOTH sources.
		const advisories = await harness.db.select().from(schema.advisories);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]?.id).toBe(GHSA);
		expect(advisories[0]?.severity).toBe('high');

		const sources = await harness.db.select().from(schema.advisorySources);
		expect(sources.map((row) => row.source).sort()).toEqual(['npm', 'osv']);

		const aliases = await harness.db.select().from(schema.advisoryAliases);
		expect(aliases.map((row) => row.alias).sort()).toContain(CVE);
		expect(aliases.every((row) => row.advisoryId === GHSA)).toBe(true);

		// The finding is new, points at scan 1, and carries the computed fix.
		const findings = await harness.db.select().from(schema.findings);
		expect(findings).toHaveLength(1);
		const finding = findings[0];
		expect(finding?.packageName).toBe('lodash');
		expect(finding?.packageVersion).toBe('4.17.15');
		expect(finding?.state).toBe('open');
		expect(finding?.firstSeenScanId).toBe(result.scanId);
		expect(finding?.fixedIn).toBe('4.17.21');
		expect(finding?.fixType).toBe('patch');
		expect(finding?.fixWithinRange).toBe(true);
		expect(finding?.isDirect).toBe(true);

		// Counters landed on the scan row.
		const scan = await harness.stores.scans.get(result.scanId);
		expect(scan?.status).toBe('ok');
		expect(scan?.totalDeps).toBe(2);
		expect(scan?.directDeps).toBe(2);
		expect(scan?.vulnHigh).toBe(1);
		expect(scan?.newFindings).toBe(1);
		expect(scan?.resolvedFindings).toBe(0);
		expect(scan?.depsReused).toBe(false);
		expect(scan?.commitSha).toBe('sha-1');

		// Outdated pass.
		const statuses = await harness.stores.dependencyStatus.forProject(
			project.id
		);
		const lodash = statuses.find((row) => row.packageName === 'lodash');
		expect(lodash?.latestVersion).toBe('4.17.21');
		expect(lodash?.updateKind).toBe('patch');
		expect(lodash?.wantedVersion).toBe('4.17.21');
		// A first observation is never a "latest just changed" signal.
		expect(lodash?.latestChangedAt).toBeNull();
		expect(scan?.outdatedCount).toBe(1);
	});

	test('pypi repo: parses uv.lock, matches OSV advisories, computes fix + outdated', async () => {
		harness.state.pythonRepo = true;
		const project = await makeProject(harness);
		const result = await harness.service.runScan(project.id, 'manual');

		expect(result.status).toBe('ok');
		expect(result.warnings).toEqual([]);

		// The set is pypi/uv and holds requests + urllib3 (root excluded).
		const sets = await harness.db.select().from(schema.dependencySets);
		expect(sets).toHaveLength(1);
		expect(sets[0]?.ecosystem).toBe('pypi');
		expect(sets[0]?.manager).toBe('uv');

		const scan = await harness.stores.scans.get(result.scanId);
		expect(scan?.totalDeps).toBe(2);
		expect(scan?.directDeps).toBe(1);

		// npm's bulk advisory endpoint is never consulted for a pypi scan.
		expect(harness.state.npmBulkCalls).toBe(0);

		// The OSV advisory landed with a pypi-scoped range.
		const ranges = await harness.db.select().from(schema.advisoryRanges);
		expect(ranges).toHaveLength(1);
		expect(ranges[0]?.ecosystem).toBe('pypi');
		expect(ranges[0]?.packageName).toBe('requests');
		expect(ranges[0]?.vulnerableRange).toBe('<2.20.0');

		// Finding with a PEP 440-computed fix.
		const findings = await harness.db.select().from(schema.findings);
		expect(findings).toHaveLength(1);
		const finding = findings[0];
		expect(finding?.advisoryId).toBe(GHSA_PY);
		expect(finding?.packageName).toBe('requests');
		expect(finding?.packageVersion).toBe('2.19.0');
		expect(finding?.severity).toBe('moderate');
		expect(finding?.isDirect).toBe(true);
		expect(finding?.fixedIn).toBe('2.20.0');
		expect(finding?.fixType).toBe('minor');
		expect(finding?.fixWithinRange).toBe(true);

		// Outdated pass answers from the PyPI project document.
		const statuses = await harness.stores.dependencyStatus.forProject(
			project.id
		);
		const requests = statuses.find((row) => row.packageName === 'requests');
		expect(requests?.latestVersion).toBe('2.32.3');
		expect(requests?.wantedVersion).toBe('2.32.3');
		expect(requests?.updateKind).toBe('minor');
		const urllib3 = statuses.find((row) => row.packageName === 'urllib3');
		expect(urllib3?.latestVersion).toBe('2.2.2');
		expect(urllib3?.updateKind).toBe('major');
		expect(scan?.outdatedCount).toBe(2);
		expect(scan?.majorOutdatedCount).toBe(1);
	});

	test('scan 2 with an identical lockfile reuses the set and produces an empty diff', async () => {
		const project = await makeProject(harness);
		const first = await harness.service.runScan(project.id, 'manual');
		const osvAfterFirst = harness.state.osvQueries;

		const second = await harness.service.runScan(project.id, 'schedule');
		expect(second.status).toBe('ok');
		expect(second.depsReused).toBe(true);

		const sets = await harness.db.select().from(schema.dependencySets);
		expect(sets).toHaveLength(1);

		const scan = await harness.stores.scans.get(second.scanId);
		expect(scan?.newFindings).toBe(0);
		expect(scan?.resolvedFindings).toBe(0);
		expect(scan?.dependencySetId).toBe(sets[0]?.id);

		// A reused dependency set skips OSV entirely.
		expect(harness.state.osvQueries).toBe(osvAfterFirst);

		const findings = await harness.db.select().from(schema.findings);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.firstSeenScanId).toBe(first.scanId);
		expect(findings[0]?.lastSeenScanId).toBe(second.scanId);

		const diff = await buildScanDiff(
			{
				findings: harness.stores.findings,
				dependencyStatus: harness.stores.dependencyStatus,
			},
			project,
			second.scanId,
			scan?.startedAt as Date
		);
		expect(diff.newFindings).toHaveLength(0);
		expect(diff.resolvedFindings).toHaveLength(0);
		expect(diff.newMajors).toHaveLength(0);
	});

	test('scan 3 with a bumped lockfile resolves the finding and writes a new set', async () => {
		const project = await makeProject(harness);
		await harness.service.runScan(project.id, 'manual');
		await harness.service.runScan(project.id, 'schedule');

		harness.state.lodashVersion = '4.17.21';
		harness.state.commitSha = 'sha-2';
		const third = await harness.service.runScan(project.id, 'schedule');
		expect(third.status).toBe('ok');
		expect(third.depsReused).toBe(false);

		const sets = await harness.db.select().from(schema.dependencySets);
		expect(sets).toHaveLength(2);

		const findings = await harness.db.select().from(schema.findings);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.state).toBe('resolved');
		expect(findings[0]?.resolvedScanId).toBe(third.scanId);
		expect(findings[0]?.resolvedAt).not.toBeNull();

		const scan = await harness.stores.scans.get(third.scanId);
		expect(scan?.resolvedFindings).toBe(1);
		expect(scan?.newFindings).toBe(0);
		expect(scan?.vulnHigh).toBe(0);

		const diff = await buildScanDiff(
			{
				findings: harness.stores.findings,
				dependencyStatus: harness.stores.dependencyStatus,
			},
			project,
			third.scanId,
			scan?.startedAt as Date
		);
		expect(diff.newFindings).toHaveLength(0);
		expect(diff.resolvedFindings).toHaveLength(1);
		expect(diff.resolvedFindings[0]?.packageName).toBe('lodash');
	});

	test('a GitHub failure fails the scan, counts it, and backs the schedule off', async () => {
		const project = await makeProject(harness);
		harness.state.githubFails = true;

		const failed = await harness.service.runScan(project.id, 'manual');
		expect(failed.status).toBe('failed');
		expect(failed.errorCode).toBe('GITHUB_ERROR');

		const scan = await harness.stores.scans.get(failed.scanId);
		expect(scan?.status).toBe('failed');
		expect(scan?.errorMessage).toContain('network failure');

		const [after] = await harness.db
			.select()
			.from(schema.projects)
			.where(eq(schema.projects.id, project.id));
		expect(after?.consecutiveFailures).toBe(1);
		expect(after?.nextScanAt.getTime()).toBeGreaterThan(Date.now());
		expect(after?.lastSuccessScanId).toBeNull();

		// The mutex released, so the project is immediately runnable again.
		expect(harness.service.isRunning(project.id)).toBe(false);
		harness.state.githubFails = false;
		const recovered = await harness.service.runScan(project.id, 'manual');
		expect(recovered.status).toBe('ok');
	});

	test('two overlapping scans of one project: exactly one wins', async () => {
		const project = await makeProject(harness);
		const results = await Promise.allSettled([
			harness.service.runScan(project.id, 'manual'),
			harness.service.runScan(project.id, 'manual'),
		]);

		const rejected = results.filter(
			(result) => result.status === 'rejected'
		);
		expect(rejected).toHaveLength(1);
		expect(
			rejected[0]?.status === 'rejected' && rejected[0].reason
		).toBeInstanceOf(ScanInProgressError);

		const scans = await harness.db.select().from(schema.scans);
		expect(scans).toHaveLength(1);
	});

	test('auto-bump: cooldown-passed direct dep is selected at latest', async () => {
		const project = await makeProject(harness);
		await harness.stores.projects.update(project.id, {
			autoBumpEnabled: true,
			autoBumpMaxKind: 'patch',
			// lodash 4.17.21 published 2021 — any realistic cooldown has passed.
			autoBumpMinReleaseAgeHours: 72,
		});

		await harness.service.runScan(project.id, 'manual');

		expect(harness.state.bumpCalls).toHaveLength(1);
		expect(harness.state.bumpCalls[0]?.selections).toEqual([
			{
				packageName: 'lodash',
				workspace: '',
				toVersion: '4.17.21',
				updateKind: 'patch',
			},
		]);
	});

	test('auto-bump: a target younger than the cooldown is excluded', async () => {
		const project = await makeProject(harness);
		// 4.17.21's publish date is ~2021; demand an age no version can meet
		// relative to "now" minus published — use an enormous cooldown.
		await harness.stores.projects.update(project.id, {
			autoBumpEnabled: true,
			autoBumpMaxKind: 'major',
			autoBumpMinReleaseAgeHours: 24 * 365 * 100,
		});

		await harness.service.runScan(project.id, 'manual');

		expect(harness.state.bumpCalls).toHaveLength(0);
	});

	test('auto-bump: missing publish timestamp fails closed', async () => {
		const packument = PACKUMENTS.lodash as { time: Record<string, string> };
		const saved = packument.time;
		packument.time = { '4.17.15': saved['4.17.15'] as string };
		try {
			const project = await makeProject(harness);
			await harness.stores.projects.update(project.id, {
				autoBumpEnabled: true,
				autoBumpMaxKind: 'major',
				autoBumpMinReleaseAgeHours: 1,
			});

			await harness.service.runScan(project.id, 'manual');
			expect(harness.state.bumpCalls).toHaveLength(0);
		} finally {
			packument.time = saved;
		}
	});

	test('auto-bump: disabled projects never dispatch', async () => {
		const project = await makeProject(harness);
		await harness.service.runScan(project.id, 'manual');
		expect(harness.state.bumpCalls).toHaveLength(0);
	});
});
