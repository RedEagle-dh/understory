import { type Db, id, schema } from '@workspace/db';
import { and, asc, eq, lte, sql } from 'drizzle-orm';

export type ProjectRow = typeof schema.projects.$inferSelect;

export interface CreateProjectInput {
	name: string;
	owner: string;
	repo: string;
	/** '' = track default branch. */
	branch: string;
	createdBy?: string;
	scanIntervalMinutes?: number;
}

export interface UpdateProjectInput {
	name?: string;
	branch?: string;
	manifestPathsJson?: string | null;
	scanIntervalMinutes?: number;
	paused?: boolean;
	autoPrEnabled?: boolean;
	autoPrMinSeverity?: ProjectRow['autoPrMinSeverity'];
	autoPrMaxBump?: ProjectRow['autoPrMaxBump'];
	autoPrKevOverride?: boolean;
	autoBumpEnabled?: boolean;
	autoBumpMaxKind?: ProjectRow['autoBumpMaxKind'];
	autoBumpMinReleaseAgeHours?: number;
	prBaseBranch?: string | null;
	prLabelsJson?: string | null;
	regenerateLockfile?: boolean;
	notifyOnNewMajor?: boolean;
}

/** Deterministic per-project offset spreading scans across the hour. */
export function scanOffsetSeconds(projectId: string): number {
	let hash = 0;
	for (const char of projectId) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return hash % 3600;
}

export function createProjectsStore(db: Db) {
	return {
		async create(input: CreateProjectInput): Promise<ProjectRow> {
			const now = new Date();
			const projectId = id();
			const [row] = await db
				.insert(schema.projects)
				.values({
					id: projectId,
					name: input.name,
					owner: input.owner,
					repo: input.repo,
					branch: input.branch,
					scanIntervalMinutes: input.scanIntervalMinutes ?? 60,
					scanOffsetSeconds: scanOffsetSeconds(projectId),
					nextScanAt: now,
					createdBy: input.createdBy ?? null,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			if (row === undefined) throw new Error('insert returned no row');
			return row;
		},

		async get(projectId: string): Promise<ProjectRow | null> {
			const row = await db.query.projects.findFirst({
				where: eq(schema.projects.id, projectId),
			});
			return row ?? null;
		},

		async list(): Promise<ProjectRow[]> {
			return db
				.select()
				.from(schema.projects)
				.orderBy(asc(schema.projects.name));
		},

		async update(
			projectId: string,
			patch: UpdateProjectInput
		): Promise<ProjectRow | null> {
			const [row] = await db
				.update(schema.projects)
				.set({ ...patch, updatedAt: new Date() })
				.where(eq(schema.projects.id, projectId))
				.returning();
			return row ?? null;
		},

		async delete(projectId: string): Promise<boolean> {
			const deleted = await db
				.delete(schema.projects)
				.where(eq(schema.projects.id, projectId))
				.returning({ id: schema.projects.id });
			return deleted.length > 0;
		},

		async setToken(
			projectId: string,
			sealed: string | null,
			last4: string | null
		): Promise<void> {
			await db
				.update(schema.projects)
				.set({
					githubTokenEnc: sealed,
					githubTokenLast4: last4,
					updatedAt: new Date(),
				})
				.where(eq(schema.projects.id, projectId));
		},

		/** Scheduler query: due, unpaused projects, oldest first. */
		async due(now: Date, limit: number): Promise<ProjectRow[]> {
			return db
				.select()
				.from(schema.projects)
				.where(
					and(
						eq(schema.projects.paused, false),
						lte(schema.projects.nextScanAt, now)
					)
				)
				.orderBy(asc(schema.projects.nextScanAt))
				.limit(limit);
		},

		async finishScan(
			projectId: string,
			outcome: {
				scanId: string;
				success: boolean;
				lockHash?: string;
				nextScanAt: Date;
			}
		): Promise<void> {
			await db
				.update(schema.projects)
				.set({
					lastScanId: outcome.scanId,
					...(outcome.success
						? {
								lastSuccessScanId: outcome.scanId,
								consecutiveFailures: 0,
								...(outcome.lockHash === undefined
									? {}
									: { lastLockHash: outcome.lockHash }),
							}
						: {
								consecutiveFailures: sql`${schema.projects.consecutiveFailures} + 1`,
							}),
					nextScanAt: outcome.nextScanAt,
					updatedAt: new Date(),
				})
				.where(eq(schema.projects.id, projectId));
		},
	};
}

export type ProjectsStore = ReturnType<typeof createProjectsStore>;
