import { beforeEach, describe, expect, test } from 'bun:test';
import {
	createRouteFactory,
	pipeline,
	type RequestContext,
} from '@declarativejs/core';
import { createTestDeps } from '@declarativejs/core/testing';
import { createDb, id, runMigrations, schema } from '@workspace/db';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../environment';
import { dashboardModule } from '../modules/dashboard';
import { createDependencyStatusStore } from '../stores/dependency-status';
import { createFindingsStore } from '../stores/findings';
import { createProjectsStore } from '../stores/projects';
import { createPullRequestsStore } from '../stores/pull-requests';
import { createScansStore } from '../stores/scans';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A minimal `AppEnv` stub: only the stores + route surface `dashboard.ts`
 * actually touches. No auth stage is installed on the pipeline, so
 * `route.execute` runs the handler directly — this mirrors how
 * `auth-stage.test.ts` builds a bare factory, minus the stage under test.
 */
function makeHarness() {
	const { db } = createDb(':memory:');
	runMigrations(db);

	const { deps } = createTestDeps();
	const route = createRouteFactory({
		surface: 'authed',
		pipeline: pipeline<RequestContext>(),
		deps,
	});

	const stores = {
		projects: createProjectsStore(db),
		scans: createScansStore(db),
		findings: createFindingsStore(db),
		dependencyStatus: createDependencyStatusStore(db),
		pullRequests: createPullRequestsStore(db),
	};

	const env = {
		surfaces: { authed: route },
		...stores,
	} as unknown as AppEnv;

	const [maybeSummaryRoute] = dashboardModule().build(env).routes ?? [];
	if (maybeSummaryRoute === undefined) throw new Error('fixture');
	// Reassigned so the variable's static type (not merely flow narrowing) is
	// non-nullable — narrowing from the guard above does not otherwise
	// survive into the closure below.
	const summaryRoute: NonNullable<typeof maybeSummaryRoute> =
		maybeSummaryRoute;

	async function callDashboard() {
		const result = await summaryRoute.execute({
			params: {},
			query: {},
			headers: {},
		});
		if (result.status !== 200) {
			throw new Error(`unexpected status ${result.status}`);
		}
		return result.body as {
			totals: {
				projects: number;
				pausedProjects: number;
				openFindings: {
					critical: number;
					high: number;
					moderate: number;
					low: number;
				};
				outdatedDeps: number;
				majorOutdated: number;
				openPrs: number;
				failingProjects: number;
			};
			worstProjects: {
				id: string;
				name: string;
				vulnCounts: {
					critical: number;
					high: number;
					moderate: number;
					low: number;
				};
			}[];
			recentScans: {
				id: string;
				projectId: string;
				projectName: string;
				status: string;
			}[];
			schedulerHealth: {
				dueNow: number;
				runningScans: number;
				lastDispatchAt: null;
			};
			trend: {
				date: string;
				critical: number | null;
				high: number | null;
				moderate: number | null;
				low: number | null;
			}[];
		};
	}

	return { db, stores, callDashboard };
}

async function insertAdvisory(
	db: ReturnType<typeof createDb>['db'],
	advisoryId: string
) {
	await db.insert(schema.advisories).values({
		id: advisoryId,
		summary: 'fixture advisory',
		severity: 'high',
		updatedAt: new Date(),
	});
}

async function insertOpenFinding(
	db: ReturnType<typeof createDb>['db'],
	input: {
		projectId: string;
		advisoryId: string;
		packageName: string;
		severity: 'critical' | 'high' | 'moderate' | 'low';
	}
) {
	const now = new Date();
	await db.insert(schema.findings).values({
		id: id(),
		projectId: input.projectId,
		advisoryId: input.advisoryId,
		packageName: input.packageName,
		packageVersion: '1.0.0',
		workspace: '',
		severity: input.severity,
		isDirect: true,
		depType: 'prod',
		state: 'open',
		firstSeenScanId: 'seed',
		firstSeenAt: now,
		lastSeenScanId: 'seed',
		lastSeenAt: now,
	});
}

async function insertScan(
	db: ReturnType<typeof createDb>['db'],
	input: {
		projectId: string;
		startedAt: Date;
		status: 'running' | 'ok' | 'failed';
		vulnCritical?: number;
		vulnHigh?: number;
	}
) {
	const scanId = id();
	await db.insert(schema.scans).values({
		id: scanId,
		projectId: input.projectId,
		trigger: 'schedule',
		status: input.status,
		startedAt: input.startedAt,
		...(input.status === 'ok'
			? {
					vulnCritical: input.vulnCritical ?? 0,
					vulnHigh: input.vulnHigh ?? 0,
					vulnModerate: 0,
					vulnLow: 0,
				}
			: {}),
	});
	return scanId;
}

describe('dashboard summary', () => {
	let harness: ReturnType<typeof makeHarness>;

	beforeEach(() => {
		harness = makeHarness();
	});

	test('totals, worst projects, scheduler health, and open PR count', async () => {
		const { db, stores } = harness;

		const p1 = await stores.projects.create({
			name: 'alpha',
			owner: 'acme',
			repo: 'alpha',
			branch: '',
		});
		const p2 = await stores.projects.create({
			name: 'beta',
			owner: 'acme',
			repo: 'beta',
			branch: '',
		});
		const p3 = await stores.projects.create({
			name: 'gamma',
			owner: 'acme',
			repo: 'gamma',
			branch: '',
		});

		// p2: paused + failing.
		await stores.projects.update(p2.id, { paused: true });
		await db
			.update(schema.projects)
			.set({ consecutiveFailures: 2 })
			.where(eq(schema.projects.id, p2.id));
		// p3: not due — nextScanAt pushed into the future.
		await db
			.update(schema.projects)
			.set({ nextScanAt: new Date(Date.now() + 60 * 60_000) })
			.where(eq(schema.projects.id, p3.id));

		await insertAdvisory(db, 'GHSA-fixture-0001');
		await insertOpenFinding(db, {
			projectId: p1.id,
			advisoryId: 'GHSA-fixture-0001',
			packageName: 'left-pad',
			severity: 'critical',
		});
		await insertOpenFinding(db, {
			projectId: p1.id,
			advisoryId: 'GHSA-fixture-0001',
			packageName: 'left-pad2',
			severity: 'critical',
		});
		await insertOpenFinding(db, {
			projectId: p1.id,
			advisoryId: 'GHSA-fixture-0001',
			packageName: 'left-pad3',
			severity: 'high',
		});
		await insertOpenFinding(db, {
			projectId: p2.id,
			advisoryId: 'GHSA-fixture-0001',
			packageName: 'left-pad4',
			severity: 'critical',
		});

		await stores.dependencyStatus.replaceForScan(
			p1.id,
			'seed-1',
			new Date(),
			[
				{
					workspace: '',
					packageName: 'a',
					currentVersion: '1.0.0',
					declaredRange: '^1.0.0',
					wantedVersion: '1.0.0',
					latestVersion: '1.1.0',
					isDirect: true,
					depType: 'prod',
					updateKind: 'minor',
					deprecatedMessage: null,
				},
				{
					workspace: '',
					packageName: 'b',
					currentVersion: '1.0.0',
					declaredRange: '^1.0.0',
					wantedVersion: '1.0.0',
					latestVersion: '1.1.0',
					isDirect: true,
					depType: 'prod',
					updateKind: 'minor',
					deprecatedMessage: null,
				},
				{
					workspace: '',
					packageName: 'c',
					currentVersion: '1.0.0',
					declaredRange: '^1.0.0',
					wantedVersion: '1.0.0',
					latestVersion: '2.0.0',
					isDirect: true,
					depType: 'prod',
					updateKind: 'major',
					deprecatedMessage: null,
				},
			]
		);
		await stores.dependencyStatus.replaceForScan(
			p2.id,
			'seed-2',
			new Date(),
			[
				{
					workspace: '',
					packageName: 'd',
					currentVersion: '1.0.0',
					declaredRange: '^1.0.0',
					wantedVersion: '1.0.1',
					latestVersion: '1.0.1',
					isDirect: true,
					depType: 'prod',
					updateKind: 'patch',
					deprecatedMessage: null,
				},
			]
		);

		const openPr = await stores.pullRequests.createPending({
			projectId: p1.id,
			branch: 'understory/bump-a',
			baseBranch: 'main',
			kind: 'manual',
			title: 'bump a',
			bumps: [],
		});
		if (openPr === null) throw new Error('fixture');
		await stores.pullRequests.markOpen(openPr.id, {
			number: 1,
			url: 'https://github.com/acme/alpha/pull/1',
			commitSha: 'sha1',
			lockfileUpdated: false,
		});
		const closedPr = await stores.pullRequests.createPending({
			projectId: p2.id,
			branch: 'understory/bump-d',
			baseBranch: 'main',
			kind: 'manual',
			title: 'bump d',
			bumps: [],
		});
		if (closedPr === null) throw new Error('fixture');
		await stores.pullRequests.markSynced(closedPr.id, { state: 'closed' });

		await insertScan(db, {
			projectId: p1.id,
			startedAt: new Date(),
			status: 'running',
		});
		await insertScan(db, {
			projectId: p3.id,
			startedAt: new Date(),
			status: 'running',
		});

		const summary = await harness.callDashboard();

		expect(summary.totals.projects).toBe(3);
		expect(summary.totals.pausedProjects).toBe(1);
		expect(summary.totals.failingProjects).toBe(1);
		expect(summary.totals.openFindings).toEqual({
			critical: 3,
			high: 1,
			moderate: 0,
			low: 0,
		});
		expect(summary.totals.outdatedDeps).toBe(4);
		expect(summary.totals.majorOutdated).toBe(1);
		expect(summary.totals.openPrs).toBe(1);

		// p1 due (unpaused, nextScanAt now-ish); p2 excluded by pause;
		// p3 excluded by a future nextScanAt.
		expect(summary.schedulerHealth.dueNow).toBe(1);
		expect(summary.schedulerHealth.runningScans).toBe(2);
		expect(summary.schedulerHealth.lastDispatchAt).toBeNull();

		expect(summary.worstProjects.map((p) => p.id)).toEqual([
			p1.id,
			p2.id,
			p3.id,
		]);
		expect(summary.worstProjects[0]?.vulnCounts).toEqual({
			critical: 2,
			high: 1,
			moderate: 0,
			low: 0,
		});

		expect(summary.recentScans).toHaveLength(2);
		expect(summary.recentScans.every((s) => s.status === 'running')).toBe(
			true
		);
	});

	test('trend: sums the last scan per project per day, nulls empty days', async () => {
		const { db, stores } = harness;

		const p1 = await stores.projects.create({
			name: 'alpha',
			owner: 'acme',
			repo: 'alpha',
			branch: '',
		});
		const p2 = await stores.projects.create({
			name: 'beta',
			owner: 'acme',
			repo: 'beta',
			branch: '',
		});

		const now = new Date();
		const twoDaysAgo = new Date(now.getTime() - 2 * MS_PER_DAY);
		const oneDayAgo = new Date(now.getTime() - MS_PER_DAY);

		// Two scans for p1 on the SAME day — only the later one should count.
		await insertScan(db, {
			projectId: p1.id,
			startedAt: new Date(twoDaysAgo.getTime() - 60_000),
			status: 'ok',
			vulnCritical: 1,
			vulnHigh: 0,
		});
		await insertScan(db, {
			projectId: p1.id,
			startedAt: twoDaysAgo,
			status: 'ok',
			vulnCritical: 3,
			vulnHigh: 1,
		});
		// p2 also scans two days ago — contributes alongside p1's last scan.
		await insertScan(db, {
			projectId: p2.id,
			startedAt: new Date(twoDaysAgo.getTime() + 30_000),
			status: 'ok',
			vulnCritical: 2,
			vulnHigh: 0,
		});
		// One day ago: only p2 scans.
		await insertScan(db, {
			projectId: p2.id,
			startedAt: oneDayAgo,
			status: 'ok',
			vulnCritical: 1,
			vulnHigh: 2,
		});
		// A failed scan today must not contribute to the trend at all.
		await insertScan(db, {
			projectId: p1.id,
			startedAt: now,
			status: 'failed',
		});

		const summary = await harness.callDashboard();

		expect(summary.trend).toHaveLength(30);

		const dayKey = (d: Date) => d.toISOString().slice(0, 10);
		const byDate = new Map(
			summary.trend.map((point) => [point.date, point])
		);

		const twoDaysAgoPoint = byDate.get(dayKey(twoDaysAgo));
		expect(twoDaysAgoPoint).toEqual({
			date: dayKey(twoDaysAgo),
			critical: 5, // p1's LAST scan (3) + p2 (2), not p1's earlier scan (1)
			high: 1,
			moderate: 0,
			low: 0,
		});

		const oneDayAgoPoint = byDate.get(dayKey(oneDayAgo));
		expect(oneDayAgoPoint).toEqual({
			date: dayKey(oneDayAgo),
			critical: 1,
			high: 2,
			moderate: 0,
			low: 0,
		});

		const todayPoint = byDate.get(dayKey(now));
		expect(todayPoint).toEqual({
			date: dayKey(now),
			critical: null,
			high: null,
			moderate: null,
			low: null,
		});

		// Every other day in the window is an empty bucket.
		const nonNullDates = summary.trend.filter((p) => p.critical !== null);
		expect(nonNullDates).toHaveLength(2);
	});
});
