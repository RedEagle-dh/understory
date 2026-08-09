import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type Db, id, runMigrations, schema } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { createFindingsStore } from '../stores/findings';
import { createPackageIndexStore } from '../stores/package-index';

/**
 * Seeds a small fleet directly through the schema — these stores are read
 * models over data the scan pipeline writes, so driving them from raw rows
 * keeps the tests about the queries rather than about the scanner.
 */
interface Fleet {
	db: Db;
	packageIndex: ReturnType<typeof createPackageIndexStore>;
	findings: ReturnType<typeof createFindingsStore>;
}

async function addProject(
	db: Db,
	input: {
		name: string;
		ecosystem?: 'npm' | 'pypi';
		/** Omit to leave the project without a successful scan. */
		packages?: {
			name: string;
			version: string;
			workspace?: string;
			isDirect?: boolean;
			depType?: 'prod' | 'dev';
			depth?: number;
		}[];
	}
): Promise<string> {
	const projectId = id();
	const now = new Date();
	await db.insert(schema.projects).values({
		id: projectId,
		name: input.name,
		owner: 'acme',
		repo: input.name,
		scanOffsetSeconds: 0,
		nextScanAt: now,
		createdAt: now,
		updatedAt: now,
	});
	if (input.packages === undefined) return projectId;

	const setId = id();
	const scanId = id();
	await db.insert(schema.dependencySets).values({
		id: setId,
		projectId,
		lockHash: `hash-${projectId}`,
		ecosystem: input.ecosystem ?? 'npm',
		manager: input.ecosystem === 'pypi' ? 'uv' : 'npm',
		packageCount: input.packages.length,
		directCount: input.packages.filter((p) => p.isDirect !== false).length,
		createdAt: now,
		firstScanId: scanId,
	});
	await db.insert(schema.scans).values({
		id: scanId,
		projectId,
		trigger: 'schedule',
		status: 'ok',
		dependencySetId: setId,
		startedAt: now,
		finishedAt: now,
	});
	await db
		.update(schema.projects)
		.set({ lastSuccessScanId: scanId, lastScanId: scanId })
		.where(eq(schema.projects.id, projectId));
	await db.insert(schema.dependencySetEntries).values(
		input.packages.map((pkg) => ({
			setId,
			name: pkg.name,
			version: pkg.version,
			workspace: pkg.workspace ?? '',
			depType: pkg.depType ?? ('prod' as const),
			isDirect: pkg.isDirect ?? true,
			depth: pkg.depth ?? 0,
			declaredRange: null,
		}))
	);
	return projectId;
}

async function addFinding(
	db: Db,
	input: {
		projectId: string;
		advisoryId: string;
		packageName: string;
		packageVersion: string;
		severity: 'critical' | 'high' | 'moderate' | 'low';
		kev?: boolean;
		epss?: number;
		state?: 'open' | 'resolved';
	}
): Promise<void> {
	const now = new Date();
	const existing = await db.query.advisories.findFirst({
		where: eq(schema.advisories.id, input.advisoryId),
	});
	if (existing === undefined) {
		await db.insert(schema.advisories).values({
			id: input.advisoryId,
			summary: `${input.advisoryId} summary`,
			severity: input.severity,
			updatedAt: now,
			epssScore: input.epss ?? null,
			kevAddedAt: input.kev === true ? now : null,
			kevKnownRansomware: input.kev === true ? false : null,
		});
	}
	await db.insert(schema.findings).values({
		id: id(),
		projectId: input.projectId,
		advisoryId: input.advisoryId,
		packageName: input.packageName,
		packageVersion: input.packageVersion,
		workspace: '',
		severity: input.severity,
		isDirect: true,
		depType: 'prod',
		state: input.state ?? 'open',
		firstSeenScanId: 'seed',
		firstSeenAt: now,
		lastSeenScanId: 'seed',
		lastSeenAt: now,
	});
}

function makeFleet(): Fleet {
	const { db } = createDb(':memory:');
	runMigrations(db);
	return {
		db,
		packageIndex: createPackageIndexStore(db),
		findings: createFindingsStore(db),
	};
}

/* -------------------------------------------------------------------------- */

describe('package index — search', () => {
	let fleet: Fleet;
	let webId: string;
	let apiId: string;

	beforeEach(async () => {
		fleet = makeFleet();
		webId = await addProject(fleet.db, {
			name: 'web',
			packages: [
				{ name: 'lodash', version: '4.17.20' },
				{ name: 'react', version: '18.2.0' },
				{
					name: 'glob',
					version: '7.2.3',
					isDirect: false,
					depType: 'dev',
					depth: 2,
				},
			],
		});
		apiId = await addProject(fleet.db, {
			name: 'api',
			packages: [
				{ name: 'lodash', version: '4.17.21' },
				{ name: 'lodash', version: '4.17.20', workspace: 'apps/worker' },
			],
		});
		// A project that has never completed a scan contributes nothing.
		await addProject(fleet.db, { name: 'never-scanned' });
		// A different ecosystem, same-ish shape.
		await addProject(fleet.db, {
			name: 'ml',
			ecosystem: 'pypi',
			packages: [{ name: 'requests', version: '2.31.0' }],
		});
	});

	test('counts the projects and versions a package appears in', async () => {
		const result = await fleet.packageIndex.search({
			q: 'lodash',
			page: 1,
			pageSize: 20,
		});
		expect(result.total).toBe(1);
		expect(result.items[0]).toMatchObject({
			name: 'lodash',
			ecosystem: 'npm',
			projectCount: 2,
			directProjectCount: 2,
			versionCount: 2,
		});
		expect(result.items[0]?.versions).toEqual(['4.17.20', '4.17.21']);
	});

	test('ignores projects without a successful scan', async () => {
		const result = await fleet.packageIndex.search({
			page: 1,
			pageSize: 50,
		});
		const names = result.items.map((item) => item.name);
		expect(names).toEqual(['glob', 'lodash', 'react', 'requests']);
	});

	test('separates ecosystems that share a package name', async () => {
		await addProject(fleet.db, {
			name: 'js-requests',
			packages: [{ name: 'requests', version: '0.0.1' }],
		});
		const result = await fleet.packageIndex.search({
			q: 'requests',
			page: 1,
			pageSize: 20,
		});
		expect(result.total).toBe(2);
		expect(
			result.items.map((item) => `${item.ecosystem}:${item.name}`).sort()
		).toEqual(['npm:requests', 'pypi:requests']);
	});

	test('filters to packages that are direct somewhere', async () => {
		const direct = await fleet.packageIndex.search({
			direct: true,
			page: 1,
			pageSize: 50,
		});
		expect(direct.items.map((item) => item.name)).not.toContain('glob');

		const transitive = await fleet.packageIndex.search({
			direct: false,
			page: 1,
			pageSize: 50,
		});
		expect(transitive.items.map((item) => item.name)).toEqual(['glob']);
	});

	test('rolls up open findings without multiplying them by workspace rows', async () => {
		await addFinding(fleet.db, {
			projectId: webId,
			advisoryId: 'GHSA-lodash',
			packageName: 'lodash',
			packageVersion: '4.17.20',
			severity: 'high',
		});
		await addFinding(fleet.db, {
			projectId: apiId,
			advisoryId: 'GHSA-lodash',
			packageName: 'lodash',
			packageVersion: '4.17.20',
			severity: 'high',
		});

		const result = await fleet.packageIndex.search({
			q: 'lodash',
			page: 1,
			pageSize: 20,
		});
		// `api` holds lodash@4.17.20 in one workspace and 4.17.21 in another;
		// a naive join would count its single finding twice.
		expect(result.items[0]).toMatchObject({
			openFindings: 2,
			affectedProjects: 2,
			maxSeverity: 'high',
		});
	});

	test('filters by whether a package has any open finding', async () => {
		await addFinding(fleet.db, {
			projectId: webId,
			advisoryId: 'GHSA-react',
			packageName: 'react',
			packageVersion: '18.2.0',
			severity: 'moderate',
		});

		const vulnerable = await fleet.packageIndex.search({
			hasVuln: true,
			page: 1,
			pageSize: 50,
		});
		expect(vulnerable.items.map((item) => item.name)).toEqual(['react']);

		const clean = await fleet.packageIndex.search({
			hasVuln: false,
			page: 1,
			pageSize: 50,
		});
		expect(clean.items.map((item) => item.name)).not.toContain('react');
	});

	test('sorts by project count and by severity', async () => {
		await addFinding(fleet.db, {
			projectId: webId,
			advisoryId: 'GHSA-glob',
			packageName: 'glob',
			packageVersion: '7.2.3',
			severity: 'critical',
		});

		const byProjects = await fleet.packageIndex.search({
			sort: 'projects',
			page: 1,
			pageSize: 50,
		});
		expect(byProjects.items[0]?.name).toBe('lodash');

		const bySeverity = await fleet.packageIndex.search({
			sort: 'severity',
			page: 1,
			pageSize: 50,
		});
		expect(bySeverity.items[0]?.name).toBe('glob');
	});

	test('pages without losing the total', async () => {
		const page = await fleet.packageIndex.search({ page: 2, pageSize: 2 });
		expect(page.total).toBe(4);
		expect(page.items).toHaveLength(2);
	});
});

describe('package index — usages', () => {
	test('groups per (project, version) and folds workspaces together', async () => {
		const fleet = makeFleet();
		const apiId = await addProject(fleet.db, {
			name: 'api',
			packages: [
				{ name: 'lodash', version: '4.17.20', workspace: '' },
				{
					name: 'lodash',
					version: '4.17.20',
					workspace: 'apps/worker',
					depType: 'dev',
				},
				{ name: 'lodash', version: '4.17.21', workspace: 'apps/admin' },
			],
		});
		await addFinding(fleet.db, {
			projectId: apiId,
			advisoryId: 'GHSA-lodash',
			packageName: 'lodash',
			packageVersion: '4.17.20',
			severity: 'high',
		});

		const result = await fleet.packageIndex.usages('lodash');
		expect(result.truncated).toBe(false);
		expect(result.items).toHaveLength(2);

		const vulnerable = result.items.find(
			(item) => item.version === '4.17.20'
		);
		expect(vulnerable?.workspaces.sort()).toEqual(['', 'apps/worker']);
		expect(vulnerable?.depTypes.sort()).toEqual(['dev', 'prod']);
		expect(vulnerable?.openFindings).toBe(1);
		expect(vulnerable?.maxSeverity).toBe('high');

		const clean = result.items.find((item) => item.version === '4.17.21');
		expect(clean?.openFindings).toBe(0);
		expect(clean?.maxSeverity).toBeNull();
	});

	test('returns nothing for a package no project ships', async () => {
		const fleet = makeFleet();
		await addProject(fleet.db, {
			name: 'web',
			packages: [{ name: 'react', version: '18.2.0' }],
		});
		const result = await fleet.packageIndex.usages('left-pad');
		expect(result.items).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */

describe('global vulnerability inbox', () => {
	let fleet: Fleet;
	let webId: string;
	let apiId: string;

	beforeEach(async () => {
		fleet = makeFleet();
		webId = await addProject(fleet.db, {
			name: 'web',
			packages: [{ name: 'lodash', version: '4.17.20' }],
		});
		apiId = await addProject(fleet.db, {
			name: 'api',
			packages: [{ name: 'minimist', version: '1.2.0' }],
		});

		await addFinding(fleet.db, {
			projectId: webId,
			advisoryId: 'GHSA-critical-boring',
			packageName: 'lodash',
			packageVersion: '4.17.20',
			severity: 'critical',
			epss: 0.0001,
		});
		await addFinding(fleet.db, {
			projectId: apiId,
			advisoryId: 'GHSA-moderate-exploited',
			packageName: 'minimist',
			packageVersion: '1.2.0',
			severity: 'moderate',
			kev: true,
			epss: 0.72,
		});
		await addFinding(fleet.db, {
			projectId: webId,
			advisoryId: 'GHSA-high-unscored',
			packageName: 'lodash',
			packageVersion: '4.17.20',
			severity: 'high',
		});
	});

	test('spans every project', async () => {
		const result = await fleet.findings.listGlobal({
			page: 1,
			pageSize: 50,
		});
		expect(result.total).toBe(3);
		expect(
			[...new Set(result.items.map((row) => row.projectName))].sort()
		).toEqual(['api', 'web']);
	});

	test('risk sorting puts exploited-in-the-wild ahead of a quiet critical', async () => {
		const result = await fleet.findings.listGlobal({
			sort: 'risk',
			page: 1,
			pageSize: 50,
		});
		expect(result.items[0]?.finding.advisoryId).toBe(
			'GHSA-moderate-exploited'
		);
		// Unscored advisories sort last — "no score" is not "score of zero".
		expect(result.items.at(-1)?.finding.advisoryId).toBe(
			'GHSA-high-unscored'
		);
	});

	test('severity sorting still ranks by CVSS label', async () => {
		const result = await fleet.findings.listGlobal({
			sort: 'severity',
			page: 1,
			pageSize: 50,
		});
		expect(result.items[0]?.finding.severity).toBe('critical');
	});

	test('filters to the KEV catalogue', async () => {
		const result = await fleet.findings.listGlobal({
			kevOnly: true,
			page: 1,
			pageSize: 50,
		});
		expect(result.total).toBe(1);
		expect(result.items[0]?.kevAddedAt).not.toBeNull();
	});

	test('searches package, advisory and project name', async () => {
		const byProject = await fleet.findings.listGlobal({
			q: 'api',
			page: 1,
			pageSize: 50,
		});
		expect(byProject.total).toBe(1);
		expect(byProject.items[0]?.projectName).toBe('api');

		const byPackage = await fleet.findings.listGlobal({
			q: 'lodash',
			page: 1,
			pageSize: 50,
		});
		expect(byPackage.total).toBe(2);
	});

	test('scopes to one project when asked', async () => {
		const result = await fleet.findings.listGlobal({
			projectId: apiId,
			page: 1,
			pageSize: 50,
		});
		expect(result.total).toBe(1);
	});

	test('summarises severity, KEV count and affected projects', async () => {
		const counts = await fleet.findings.globalOpenCounts();
		expect(counts).toMatchObject({
			critical: 1,
			high: 1,
			moderate: 1,
			low: 0,
			kev: 1,
			projects: 2,
		});
	});

	test('excludes resolved findings by default', async () => {
		await addFinding(fleet.db, {
			projectId: webId,
			advisoryId: 'GHSA-old',
			packageName: 'lodash',
			packageVersion: '4.17.19',
			severity: 'low',
			state: 'resolved',
		});
		const open = await fleet.findings.listGlobal({ page: 1, pageSize: 50 });
		expect(open.total).toBe(3);

		const resolved = await fleet.findings.listGlobal({
			state: ['resolved'],
			page: 1,
			pageSize: 50,
		});
		expect(resolved.total).toBe(1);
	});
});
