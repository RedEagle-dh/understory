import type { DepType, UpdateKind } from '@workspace/audit-engine';
import { type Db, id, schema } from '@workspace/db';
import { and, eq, inArray, like, ne, type SQL, sql } from 'drizzle-orm';

export type DependencyStatusRow = typeof schema.dependencyStatus.$inferSelect;

const INSERT_CHUNK = 200;

export interface DependencyStatusInput {
	workspace: string;
	packageName: string;
	currentVersion: string;
	declaredRange: string | null;
	wantedVersion: string | null;
	latestVersion: string | null;
	isDirect: boolean;
	depType: DepType;
	updateKind: UpdateKind;
	deprecatedMessage: string | null;
}

export interface DependencyStatusFilters {
	updateKind?: readonly UpdateKind[];
	isDirect?: boolean;
	workspace?: string;
	q?: string;
	page: number;
	pageSize: number;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Current outdated state, overwritten in place per scan. The only history kept
 * is `previousLatestVersion` + `latestChangedAt`, which together answer "a new
 * major became available during THIS scan" without storing a snapshot.
 */
export function createDependencyStatusStore(db: Db) {
	return {
		/**
		 * Upsert every row observed by this scan, then delete rows the scan did
		 * not see (the package left the tree). One transaction so a reader
		 * never observes a half-replaced set.
		 */
		async replaceForScan(
			projectId: string,
			scanId: string,
			scanStartedAt: Date,
			rows: readonly DependencyStatusInput[]
		): Promise<void> {
			const now = new Date();
			const changedAt = scanStartedAt.getTime();

			const values = rows.map((row) => ({
				id: id(),
				projectId,
				workspace: row.workspace,
				packageName: row.packageName,
				currentVersion: row.currentVersion,
				declaredRange: row.declaredRange,
				wantedVersion: row.wantedVersion,
				latestVersion: row.latestVersion,
				isDirect: row.isDirect,
				depType: row.depType,
				updateKind: row.updateKind,
				deprecatedMessage: row.deprecatedMessage,
				// Deliberately null on first insert: a brand-new row has no
				// previous `latest`, so it must not read as "changed".
				previousLatestVersion: null,
				latestChangedAt: null,
				lastCheckedAt: now,
				lastSeenScanId: scanId,
			}));

			db.transaction((tx) => {
				for (const chunk of chunked(values, INSERT_CHUNK)) {
					tx.insert(schema.dependencyStatus)
						.values(chunk)
						.onConflictDoUpdate({
							target: [
								schema.dependencyStatus.projectId,
								schema.dependencyStatus.workspace,
								schema.dependencyStatus.packageName,
							],
							set: {
								currentVersion: sql`excluded.current_version`,
								declaredRange: sql`excluded.declared_range`,
								wantedVersion: sql`excluded.wanted_version`,
								latestVersion: sql`excluded.latest_version`,
								isDirect: sql`excluded.is_direct`,
								depType: sql`excluded.dep_type`,
								updateKind: sql`excluded.update_kind`,
								deprecatedMessage: sql`excluded.deprecated_message`,
								// `IS NOT` is SQLite's null-safe inequality.
								previousLatestVersion: sql`case when "dependency_status"."latest_version" is not excluded.latest_version then "dependency_status"."latest_version" else "dependency_status"."previous_latest_version" end`,
								latestChangedAt: sql`case when "dependency_status"."latest_version" is not excluded.latest_version then ${changedAt} else "dependency_status"."latest_changed_at" end`,
								lastCheckedAt: sql`excluded.last_checked_at`,
								lastSeenScanId: sql`excluded.last_seen_scan_id`,
							},
						})
						.run();
				}

				tx.delete(schema.dependencyStatus)
					.where(
						and(
							eq(schema.dependencyStatus.projectId, projectId),
							ne(schema.dependencyStatus.lastSeenScanId, scanId)
						)
					)
					.run();
			});
		},

		async outdatedCounts(
			projectId: string
		): Promise<{ outdated: number; major: number }> {
			const rows = await db
				.select({
					updateKind: schema.dependencyStatus.updateKind,
					count: sql<number>`count(*)`,
				})
				.from(schema.dependencyStatus)
				.where(eq(schema.dependencyStatus.projectId, projectId))
				.groupBy(schema.dependencyStatus.updateKind);
			let outdated = 0;
			let major = 0;
			for (const row of rows) {
				if (row.updateKind === 'none') continue;
				outdated += row.count;
				if (row.updateKind === 'major') major += row.count;
			}
			return { outdated, major };
		},

		/** One grouped query for the whole projects list. */
		async outdatedCountsByProject(): Promise<
			Map<string, { outdated: number; major: number }>
		> {
			const rows = await db
				.select({
					projectId: schema.dependencyStatus.projectId,
					updateKind: schema.dependencyStatus.updateKind,
					count: sql<number>`count(*)`,
				})
				.from(schema.dependencyStatus)
				.where(ne(schema.dependencyStatus.updateKind, 'none'))
				.groupBy(
					schema.dependencyStatus.projectId,
					schema.dependencyStatus.updateKind
				);
			const out = new Map<string, { outdated: number; major: number }>();
			for (const row of rows) {
				let counts = out.get(row.projectId);
				if (counts === undefined) {
					counts = { outdated: 0, major: 0 };
					out.set(row.projectId, counts);
				}
				counts.outdated += row.count;
				if (row.updateKind === 'major') counts.major += row.count;
			}
			return out;
		},

		async listForProject(
			projectId: string,
			filters: DependencyStatusFilters
		): Promise<{ items: DependencyStatusRow[]; total: number }> {
			const clauses: (SQL | undefined)[] = [
				eq(schema.dependencyStatus.projectId, projectId),
			];
			if (
				filters.updateKind !== undefined &&
				filters.updateKind.length > 0
			) {
				clauses.push(
					inArray(schema.dependencyStatus.updateKind, [
						...filters.updateKind,
					])
				);
			}
			if (filters.isDirect !== undefined) {
				clauses.push(
					eq(schema.dependencyStatus.isDirect, filters.isDirect)
				);
			}
			if (filters.workspace !== undefined) {
				clauses.push(
					eq(schema.dependencyStatus.workspace, filters.workspace)
				);
			}
			if (filters.q !== undefined && filters.q !== '') {
				clauses.push(
					like(
						schema.dependencyStatus.packageName,
						`%${escapeLike(filters.q)}%`
					)
				);
			}
			const where = and(...clauses);
			const [items, [total]] = await Promise.all([
				db
					.select()
					.from(schema.dependencyStatus)
					.where(where)
					.orderBy(schema.dependencyStatus.packageName)
					.limit(filters.pageSize)
					.offset((filters.page - 1) * filters.pageSize),
				db
					.select({ count: sql<number>`count(*)` })
					.from(schema.dependencyStatus)
					.where(where),
			]);
			return { items, total: total?.count ?? 0 };
		},

		async forProject(projectId: string): Promise<DependencyStatusRow[]> {
			return db
				.select()
				.from(schema.dependencyStatus)
				.where(eq(schema.dependencyStatus.projectId, projectId));
		},

		async forPackage(
			projectId: string,
			packageName: string
		): Promise<DependencyStatusRow[]> {
			return db
				.select()
				.from(schema.dependencyStatus)
				.where(
					and(
						eq(schema.dependencyStatus.projectId, projectId),
						eq(schema.dependencyStatus.packageName, packageName)
					)
				);
		},

		/** The "new major available" signal for a specific scan. */
		async newMajorsForScan(
			projectId: string,
			scanStartedAt: Date
		): Promise<DependencyStatusRow[]> {
			return db
				.select()
				.from(schema.dependencyStatus)
				.where(
					and(
						eq(schema.dependencyStatus.projectId, projectId),
						eq(schema.dependencyStatus.updateKind, 'major'),
						eq(
							schema.dependencyStatus.latestChangedAt,
							scanStartedAt
						)
					)
				)
				.limit(500);
		},
	};
}

export type DependencyStatusStore = ReturnType<
	typeof createDependencyStatusStore
>;
