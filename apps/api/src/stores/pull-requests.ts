import { type Db, id, schema } from '@workspace/db';
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';

export type PullRequestRow = typeof schema.pullRequests.$inferSelect;
export type PullRequestBumpRow = typeof schema.pullRequestBumps.$inferSelect;
export type PullRequestState = PullRequestRow['state'];
export type PullRequestKind = PullRequestRow['kind'];

/** States a PR can still change out of — the sync job's working set. */
export const ACTIVE_STATES = [
	'creating',
	'open',
] as const satisfies readonly PullRequestState[];

export interface PullRequestBumpInput {
	packageName: string;
	/** '' = the workspace root. */
	workspace: string;
	fromRange: string | null;
	fromVersion: string | null;
	toVersion: string;
	advisoryId: string | null;
	findingId: string | null;
}

export interface CreatePullRequestInput {
	projectId: string;
	branch: string;
	baseBranch: string;
	kind: PullRequestKind;
	title: string;
	createdByUserId?: string | null;
	bumps: readonly PullRequestBumpInput[];
}

export interface PullRequestWithBumps {
	pullRequest: PullRequestRow;
	bumps: PullRequestBumpRow[];
}

/** What the dedupe query is asked to cover. */
export interface CoverageRequest {
	packageName: string;
	workspace: string;
	toVersion: string;
}

/** `true` when `a` is at least as new as `b`, tolerating non-semver strings. */
function atLeast(a: string, b: string): boolean {
	if (a === b) return true;
	const parsedA = parseLoose(a);
	const parsedB = parseLoose(b);
	if (parsedA === null || parsedB === null) return false;
	for (let index = 0; index < 3; index += 1) {
		const left = parsedA[index] ?? 0;
		const right = parsedB[index] ?? 0;
		if (left !== right) return left > right;
	}
	return true;
}

function parseLoose(value: string): number[] | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Pull requests the system opened, plus the bumps they carry.
 *
 * `createPending` is the write that matters: it inserts the `creating` row and
 * every bump in ONE transaction, and returns `null` instead of throwing when
 * `uniqueIndex(project_id, branch)` rejects it. Branch names are deterministic,
 * so that rejection *is* the idempotency answer — the caller loads the existing
 * row and reports it rather than opening a duplicate.
 */
export function createPullRequestsStore(db: Db) {
	function isUniqueViolation(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return (
			message.includes('UNIQUE constraint failed') ||
			message.includes('SQLITE_CONSTRAINT_UNIQUE')
		);
	}

	async function bumpsFor(
		pullRequestIds: readonly string[]
	): Promise<Map<string, PullRequestBumpRow[]>> {
		const out = new Map<string, PullRequestBumpRow[]>();
		if (pullRequestIds.length === 0) return out;
		const rows = await db
			.select()
			.from(schema.pullRequestBumps)
			.where(
				inArray(schema.pullRequestBumps.pullRequestId, [
					...pullRequestIds,
				])
			);
		for (const row of rows) {
			const bucket = out.get(row.pullRequestId);
			if (bucket === undefined) out.set(row.pullRequestId, [row]);
			else bucket.push(row);
		}
		return out;
	}

	async function withBumps(
		rows: readonly PullRequestRow[]
	): Promise<PullRequestWithBumps[]> {
		const byId = await bumpsFor(rows.map((row) => row.id));
		return rows.map((row) => ({
			pullRequest: row,
			bumps: byId.get(row.id) ?? [],
		}));
	}

	return {
		async createPending(
			input: CreatePullRequestInput
		): Promise<PullRequestRow | null> {
			const now = new Date();
			const row = {
				id: id(),
				projectId: input.projectId,
				number: null,
				url: null,
				branch: input.branch,
				baseBranch: input.baseBranch,
				kind: input.kind,
				state: 'creating' as const,
				title: input.title,
				commitSha: null,
				lockfileUpdated: false,
				createdByUserId: input.createdByUserId ?? null,
				createdAt: now,
				updatedAt: now,
				mergedAt: null,
				closedAt: null,
				lastSyncedAt: null,
				errorMessage: null,
			};

			try {
				db.transaction((tx) => {
					tx.insert(schema.pullRequests).values(row).run();
					if (input.bumps.length > 0) {
						tx.insert(schema.pullRequestBumps)
							.values(
								input.bumps.map((bump) => ({
									id: id(),
									pullRequestId: row.id,
									packageName: bump.packageName,
									workspace: bump.workspace,
									fromRange: bump.fromRange,
									fromVersion: bump.fromVersion,
									toVersion: bump.toVersion,
									advisoryId: bump.advisoryId,
									findingId: bump.findingId,
								}))
							)
							.run();
					}
				});
			} catch (error) {
				if (isUniqueViolation(error)) return null;
				throw error;
			}
			return row;
		},

		async byId(pullRequestId: string): Promise<PullRequestRow | null> {
			const row = await db.query.pullRequests.findFirst({
				where: eq(schema.pullRequests.id, pullRequestId),
			});
			return row ?? null;
		},

		async byBranch(
			projectId: string,
			branch: string
		): Promise<PullRequestRow | null> {
			const row = await db.query.pullRequests.findFirst({
				where: and(
					eq(schema.pullRequests.projectId, projectId),
					eq(schema.pullRequests.branch, branch)
				),
			});
			return row ?? null;
		},

		bumpsFor,

		async listForProject(
			projectId: string,
			filters: {
				state?: readonly PullRequestState[];
				page: number;
				pageSize: number;
			}
		): Promise<{ items: PullRequestWithBumps[]; total: number }> {
			const clauses: (SQL | undefined)[] = [
				eq(schema.pullRequests.projectId, projectId),
			];
			if (filters.state !== undefined && filters.state.length > 0) {
				clauses.push(
					inArray(schema.pullRequests.state, [...filters.state])
				);
			}
			const where = and(...clauses);
			const [rows, [total]] = await Promise.all([
				db
					.select()
					.from(schema.pullRequests)
					.where(where)
					.orderBy(desc(schema.pullRequests.createdAt))
					.limit(filters.pageSize)
					.offset((filters.page - 1) * filters.pageSize),
				db
					.select({ count: sql<number>`count(*)` })
					.from(schema.pullRequests)
					.where(where),
			]);
			return {
				items: await withBumps(rows),
				total: total?.count ?? 0,
			};
		},

		/** Dashboard totals: open PRs across every project, as a single count. */
		async countOpen(): Promise<number> {
			const [row] = await db
				.select({ count: sql<number>`count(*)` })
				.from(schema.pullRequests)
				.where(eq(schema.pullRequests.state, 'open'));
			return row?.count ?? 0;
		},

		/** Every PR still in flight, across all projects — the sync job's input. */
		async listActive(limit = 500): Promise<PullRequestRow[]> {
			return db
				.select()
				.from(schema.pullRequests)
				.where(inArray(schema.pullRequests.state, [...ACTIVE_STATES]))
				.orderBy(schema.pullRequests.createdAt)
				.limit(limit);
		},

		/**
		 * The dedupe question: is there already a `creating|open` PR for this
		 * project whose bumps cover EVERY requested `(package, ≥ version)`?
		 *
		 * Coverage is checked per package name rather than per workspace: an
		 * open PR that already bumps lodash to 4.17.21 in the root makes a
		 * second PR for the same version pointless noise, whichever workspace
		 * asked for it.
		 */
		async findCovering(
			projectId: string,
			wanted: readonly CoverageRequest[]
		): Promise<PullRequestRow | null> {
			if (wanted.length === 0) return null;
			const active = await db
				.select()
				.from(schema.pullRequests)
				.where(
					and(
						eq(schema.pullRequests.projectId, projectId),
						inArray(schema.pullRequests.state, [...ACTIVE_STATES])
					)
				)
				.orderBy(desc(schema.pullRequests.createdAt))
				.limit(100);
			if (active.length === 0) return null;

			const bumps = await bumpsFor(active.map((row) => row.id));
			for (const row of active) {
				const covered = bumps.get(row.id) ?? [];
				const satisfiesAll = wanted.every((request) =>
					covered.some(
						(bump) =>
							bump.packageName === request.packageName &&
							atLeast(bump.toVersion, request.toVersion)
					)
				);
				if (satisfiesAll) return row;
			}
			return null;
		},

		async markOpen(
			pullRequestId: string,
			outcome: {
				number: number;
				url: string;
				commitSha: string;
				lockfileUpdated: boolean;
				title?: string;
			}
		): Promise<PullRequestRow | null> {
			const now = new Date();
			const [row] = await db
				.update(schema.pullRequests)
				.set({
					state: 'open',
					number: outcome.number,
					url: outcome.url,
					commitSha: outcome.commitSha,
					lockfileUpdated: outcome.lockfileUpdated,
					...(outcome.title === undefined
						? {}
						: { title: outcome.title }),
					errorMessage: null,
					lastSyncedAt: now,
					updatedAt: now,
				})
				.where(eq(schema.pullRequests.id, pullRequestId))
				.returning();
			return row ?? null;
		},

		async markFailed(
			pullRequestId: string,
			errorMessage: string
		): Promise<void> {
			const now = new Date();
			await db
				.update(schema.pullRequests)
				.set({
					state: 'failed',
					errorMessage: errorMessage.slice(0, 500),
					updatedAt: now,
					lastSyncedAt: now,
				})
				.where(eq(schema.pullRequests.id, pullRequestId));
		},

		async markSynced(
			pullRequestId: string,
			outcome: {
				state: PullRequestState;
				mergedAt?: Date | null;
				closedAt?: Date | null;
				number?: number | null;
				url?: string | null;
			}
		): Promise<PullRequestRow | null> {
			const now = new Date();
			const [row] = await db
				.update(schema.pullRequests)
				.set({
					state: outcome.state,
					...(outcome.mergedAt === undefined
						? {}
						: { mergedAt: outcome.mergedAt }),
					...(outcome.closedAt === undefined
						? {}
						: { closedAt: outcome.closedAt }),
					...(outcome.number === undefined || outcome.number === null
						? {}
						: { number: outcome.number }),
					...(outcome.url === undefined || outcome.url === null
						? {}
						: { url: outcome.url }),
					lastSyncedAt: now,
					updatedAt: now,
				})
				.where(eq(schema.pullRequests.id, pullRequestId))
				.returning();
			return row ?? null;
		},

		async touchSynced(pullRequestId: string): Promise<void> {
			await db
				.update(schema.pullRequests)
				.set({ lastSyncedAt: new Date() })
				.where(eq(schema.pullRequests.id, pullRequestId));
		},
	};
}

export type PullRequestsStore = ReturnType<typeof createPullRequestsStore>;
