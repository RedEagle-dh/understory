import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';
import { SeverityCounts } from '../schemas/common';
import type { ScanTrendRow } from '../stores/scans';

/** How far back the trend chart looks. Also the response array's length. */
const TREND_DAYS = 30;
const WORST_PROJECTS_LIMIT = 5;
const RECENT_SCANS_LIMIT = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const EMPTY_COUNTS = { critical: 0, high: 0, moderate: 0, low: 0 } as const;

interface TrendPointValue {
	date: string;
	critical: number | null;
	high: number | null;
	moderate: number | null;
	low: number | null;
}

const TrendPoint = t.Object({
	date: t.String(),
	critical: t.Union([t.Number(), t.Null()]),
	high: t.Union([t.Number(), t.Null()]),
	moderate: t.Union([t.Number(), t.Null()]),
	low: t.Union([t.Number(), t.Null()]),
});

const WorstProject = t.Object({
	id: t.String(),
	name: t.String(),
	vulnCounts: SeverityCounts,
});

const RecentScan = t.Object({
	id: t.String(),
	projectId: t.String(),
	projectName: t.String(),
	status: t.Union([
		t.Literal('running'),
		t.Literal('ok'),
		t.Literal('failed'),
	]),
	trigger: t.Union([
		t.Literal('schedule'),
		t.Literal('manual'),
		t.Literal('auto'),
	]),
	startedAt: t.Date(),
	finishedAt: t.Union([t.Date(), t.Null()]),
	newFindings: t.Union([t.Number(), t.Null()]),
	resolvedFindings: t.Union([t.Number(), t.Null()]),
});

const DashboardSummaryView = t.Object({
	totals: t.Object({
		projects: t.Number(),
		pausedProjects: t.Number(),
		openFindings: SeverityCounts,
		outdatedDeps: t.Number(),
		majorOutdated: t.Number(),
		openPrs: t.Number(),
		failingProjects: t.Number(),
	}),
	worstProjects: t.Array(WorstProject, { maxItems: WORST_PROJECTS_LIMIT }),
	recentScans: t.Array(RecentScan, { maxItems: RECENT_SCANS_LIMIT }),
	schedulerHealth: t.Object({
		dueNow: t.Number(),
		runningScans: t.Number(),
		/** No table persists the scheduler's last tick — see the field's doc comment for why. */
		lastDispatchAt: t.Null(),
	}),
	trend: t.Array(TrendPoint, { maxItems: TREND_DAYS }),
});

/** `YYYY-MM-DD` in UTC — the trend bucket key, independent of server/client timezone. */
function dayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/**
 * One point per UTC calendar day, oldest first, over the trailing
 * `TREND_DAYS` window (today inclusive). For each day, only the LAST
 * successful scan of that day counts per project (a project that scanned
 * three times in one day must not triple-count that day's vulnerabilities);
 * counts are then summed across every project that scanned that day. A day
 * with no successful scan anywhere renders as nulls rather than a
 * carried-forward value — the chart's job to decide how to render a gap, not
 * this endpoint's to guess at it.
 */
function buildTrend(
	rows: readonly ScanTrendRow[],
	now: Date
): TrendPointValue[] {
	// project -> day -> the row with the latest startedAt seen for that day.
	const lastPerProjectDay = new Map<string, Map<string, ScanTrendRow>>();
	for (const row of rows) {
		const key = dayKey(row.startedAt);
		let byDay = lastPerProjectDay.get(row.projectId);
		if (byDay === undefined) {
			byDay = new Map();
			lastPerProjectDay.set(row.projectId, byDay);
		}
		const existing = byDay.get(key);
		if (
			existing === undefined ||
			row.startedAt.getTime() > existing.startedAt.getTime()
		) {
			byDay.set(key, row);
		}
	}

	const byDay = new Map<
		string,
		{ critical: number; high: number; moderate: number; low: number }
	>();
	for (const perDay of lastPerProjectDay.values()) {
		for (const [key, row] of perDay) {
			const bucket = byDay.get(key) ?? { ...EMPTY_COUNTS };
			bucket.critical += row.vulnCritical ?? 0;
			bucket.high += row.vulnHigh ?? 0;
			bucket.moderate += row.vulnModerate ?? 0;
			bucket.low += row.vulnLow ?? 0;
			byDay.set(key, bucket);
		}
	}

	const points: TrendPointValue[] = [];
	for (let offset = TREND_DAYS - 1; offset >= 0; offset -= 1) {
		const date = new Date(now.getTime() - offset * MS_PER_DAY);
		const key = dayKey(date);
		const bucket = byDay.get(key);
		points.push(
			bucket === undefined
				? {
						date: key,
						critical: null,
						high: null,
						moderate: null,
						low: null,
					}
				: { date: key, ...bucket }
		);
	}
	return points;
}

export function dashboardModule() {
	return defineModule({
		id: 'dashboard',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			const summary = route({
				id: 'dashboard.summary',
				method: 'GET',
				path: '/api/dashboard',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Undefined(),
				response: DashboardSummaryView,
				docs: {
					summary:
						'Aggregate totals, worst offenders, recent activity, and a 30-day trend',
					tag: 'Dashboard',
				},
				handler: async () => {
					const now = new Date();
					const since = new Date(
						now.getTime() - (TREND_DAYS - 1) * MS_PER_DAY
					);

					// A batch of GROUP BY / count queries, not N+1: the same
					// rollup pattern `modules/projects.ts` uses for its list.
					const [
						projects,
						vulnByProject,
						outdatedByProject,
						openPrs,
						runningScans,
						recentScans,
						trendRows,
					] = await Promise.all([
						env.projects.list(),
						env.findings.openCountsByProject(),
						env.dependencyStatus.outdatedCountsByProject(),
						env.pullRequests.countOpen(),
						env.scans.countByStatus('running'),
						env.scans.recentAcrossProjects(RECENT_SCANS_LIMIT),
						env.scans.trendRows(since),
					]);

					const totals = {
						projects: projects.length,
						pausedProjects: 0,
						openFindings: { ...EMPTY_COUNTS },
						outdatedDeps: 0,
						majorOutdated: 0,
						openPrs,
						failingProjects: 0,
					};
					let dueNow = 0;

					const worstProjects = projects.map((project) => {
						const counts = vulnByProject.get(project.id) ?? {
							...EMPTY_COUNTS,
						};
						const outdated = outdatedByProject.get(project.id) ?? {
							outdated: 0,
							major: 0,
						};

						if (project.paused) totals.pausedProjects += 1;
						if (project.consecutiveFailures > 0) {
							totals.failingProjects += 1;
						}
						if (
							!project.paused &&
							project.nextScanAt.getTime() <= now.getTime()
						) {
							dueNow += 1;
						}
						totals.openFindings.critical += counts.critical;
						totals.openFindings.high += counts.high;
						totals.openFindings.moderate += counts.moderate;
						totals.openFindings.low += counts.low;
						totals.outdatedDeps += outdated.outdated;
						totals.majorOutdated += outdated.major;

						return {
							id: project.id,
							name: project.name,
							vulnCounts: counts,
						};
					});
					worstProjects.sort(
						(a, b) =>
							b.vulnCounts.critical - a.vulnCounts.critical ||
							b.vulnCounts.high - a.vulnCounts.high
					);

					return {
						totals,
						worstProjects: worstProjects.slice(
							0,
							WORST_PROJECTS_LIMIT
						),
						recentScans: recentScans.map((entry) => ({
							id: entry.scan.id,
							projectId: entry.scan.projectId,
							projectName: entry.projectName,
							status: entry.scan.status,
							trigger: entry.scan.trigger,
							startedAt: entry.scan.startedAt,
							finishedAt: entry.scan.finishedAt,
							newFindings: entry.scan.newFindings,
							resolvedFindings: entry.scan.resolvedFindings,
						})),
						schedulerHealth: {
							dueNow,
							runningScans,
							// `scan.dispatch` runs every minute and is stateless
							// between ticks (see modules/jobs.ts) — nothing
							// persists "the last time it ran" today. Wiring that
							// up would mean a new settings/system-table column
							// written on every tick purely for this display
							// field; flagged as a schema wish rather than added
							// speculatively.
							lastDispatchAt: null,
						},
						trend: buildTrend(trendRows, now),
					};
				},
			});

			return { routes: [summary] as const };
		},
	});
}
