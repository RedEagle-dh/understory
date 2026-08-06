import { type Db, id, schema } from '@workspace/db';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

export type ScanRow = typeof schema.scans.$inferSelect;
export type ScanTrigger = ScanRow['trigger'];
export type ScanStatus = ScanRow['status'];

export interface RecentScanWithProject {
	scan: ScanRow;
	projectName: string;
}

/** The dashboard trend query's raw row shape — just the columns it sums. */
export interface ScanTrendRow {
	projectId: string;
	startedAt: Date;
	vulnCritical: number | null;
	vulnHigh: number | null;
	vulnModerate: number | null;
	vulnLow: number | null;
}

export interface ScanCounters {
	totalDeps: number;
	directDeps: number;
	peerDeps: number;
	vulnCritical: number;
	vulnHigh: number;
	vulnModerate: number;
	vulnLow: number;
	outdatedCount: number;
	majorOutdatedCount: number;
	newFindings: number;
	resolvedFindings: number;
}

export function createScansStore(db: Db) {
	return {
		async begin(input: {
			projectId: string;
			trigger: ScanTrigger;
			triggeredBy?: string;
		}): Promise<ScanRow> {
			const [row] = await db
				.insert(schema.scans)
				.values({
					id: id(),
					projectId: input.projectId,
					trigger: input.trigger,
					status: 'running',
					startedAt: new Date(),
					triggeredBy: input.triggeredBy ?? null,
				})
				.returning();
			if (row === undefined) throw new Error('insert returned no row');
			return row;
		},

		async get(scanId: string): Promise<ScanRow | null> {
			const row = await db.query.scans.findFirst({
				where: eq(schema.scans.id, scanId),
			});
			return row ?? null;
		},

		/** Batch lookup — the projects list resolves every `lastScanId` at once. */
		async byIds(scanIds: readonly string[]): Promise<ScanRow[]> {
			if (scanIds.length === 0) return [];
			return db
				.select()
				.from(schema.scans)
				.where(inArray(schema.scans.id, [...scanIds]));
		},

		async listForProject(
			projectId: string,
			limit: number,
			offset: number
		): Promise<ScanRow[]> {
			return db
				.select()
				.from(schema.scans)
				.where(eq(schema.scans.projectId, projectId))
				.orderBy(desc(schema.scans.startedAt))
				.limit(limit)
				.offset(offset);
		},

		async countForProject(projectId: string): Promise<number> {
			const [row] = await db
				.select({ count: sql<number>`count(*)` })
				.from(schema.scans)
				.where(eq(schema.scans.projectId, projectId));
			return row?.count ?? 0;
		},

		/** Dashboard scheduler health: scans currently `running`, across every project. */
		async countByStatus(status: ScanStatus): Promise<number> {
			const [row] = await db
				.select({ count: sql<number>`count(*)` })
				.from(schema.scans)
				.where(eq(schema.scans.status, status));
			return row?.count ?? 0;
		},

		/** The dashboard's activity feed: the newest scans across every project, with the project name joined in. */
		async recentAcrossProjects(
			limit: number
		): Promise<RecentScanWithProject[]> {
			return db
				.select({
					scan: schema.scans,
					projectName: schema.projects.name,
				})
				.from(schema.scans)
				.innerJoin(
					schema.projects,
					eq(schema.projects.id, schema.scans.projectId)
				)
				.orderBy(desc(schema.scans.startedAt))
				.limit(limit);
		},

		/**
		 * Raw rows for the dashboard trend chart: every successful scan since
		 * `since`. Deliberately unaggregated — picking "the last scan per
		 * project per day" and summing across projects is a JS pass in
		 * `modules/dashboard.ts`, not SQL, because SQLite has no clean
		 * per-group "row with the max column" without a correlated subquery
		 * per project per day; a handful of scan rows over 30 days is cheap to
		 * group in memory.
		 */
		async trendRows(since: Date): Promise<ScanTrendRow[]> {
			return db
				.select({
					projectId: schema.scans.projectId,
					startedAt: schema.scans.startedAt,
					vulnCritical: schema.scans.vulnCritical,
					vulnHigh: schema.scans.vulnHigh,
					vulnModerate: schema.scans.vulnModerate,
					vulnLow: schema.scans.vulnLow,
				})
				.from(schema.scans)
				.where(
					and(
						eq(schema.scans.status, 'ok'),
						gte(schema.scans.startedAt, since)
					)
				);
		},

		/**
		 * Retention: every scan of this project ordered newest-first, so the
		 * pruner can keep N and drop the tail. `id` breaks `startedAt` ties
		 * (two scans can share a millisecond) — without it the "newest N" set
		 * is not stable between the two queries.
		 */
		async listIdsForRetention(
			projectId: string
		): Promise<{ id: string; dependencySetId: string | null }[]> {
			return db
				.select({
					id: schema.scans.id,
					dependencySetId: schema.scans.dependencySetId,
				})
				.from(schema.scans)
				.where(eq(schema.scans.projectId, projectId))
				.orderBy(desc(schema.scans.startedAt), desc(schema.scans.id));
		},

		async deleteByIds(scanIds: readonly string[]): Promise<number> {
			if (scanIds.length === 0) return 0;
			let deleted = 0;
			for (let index = 0; index < scanIds.length; index += 200) {
				const chunk = scanIds.slice(index, index + 200);
				const rows = await db
					.delete(schema.scans)
					.where(inArray(schema.scans.id, [...chunk]))
					.returning({ id: schema.scans.id });
				deleted += rows.length;
			}
			return deleted;
		},

		async succeed(
			scanId: string,
			result: {
				commitSha: string;
				branch: string;
				dependencySetId: string;
				lockHash: string;
				depsReused: boolean;
				counters: ScanCounters;
			}
		): Promise<void> {
			const finishedAt = new Date();
			const scan = await this.get(scanId);
			await db
				.update(schema.scans)
				.set({
					status: 'ok',
					commitSha: result.commitSha,
					branch: result.branch,
					dependencySetId: result.dependencySetId,
					lockHash: result.lockHash,
					depsReused: result.depsReused,
					finishedAt,
					durationMs:
						scan === null
							? null
							: finishedAt.getTime() - scan.startedAt.getTime(),
					...result.counters,
				})
				.where(eq(schema.scans.id, scanId));
		},

		async fail(
			scanId: string,
			errorCode: string,
			errorMessage: string
		): Promise<void> {
			const finishedAt = new Date();
			const scan = await this.get(scanId);
			await db
				.update(schema.scans)
				.set({
					status: 'failed',
					errorCode,
					errorMessage: errorMessage.slice(0, 2000),
					finishedAt,
					durationMs:
						scan === null
							? null
							: finishedAt.getTime() - scan.startedAt.getTime(),
				})
				.where(eq(schema.scans.id, scanId));
		},
	};
}

export type ScansStore = ReturnType<typeof createScansStore>;
