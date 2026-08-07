import type {
	DependencyGraph,
	DepType,
	PackageManager,
	Severity,
	UpdateKind,
} from '@workspace/audit-engine';
import { type Db, id, schema } from '@workspace/db';
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	like,
	notInArray,
	type SQL,
	sql,
} from 'drizzle-orm';

export type DependencySetRow = typeof schema.dependencySets.$inferSelect;
export type DependencySetEntryRow =
	typeof schema.dependencySetEntries.$inferSelect;
export type NewDependencySetEntry =
	typeof schema.dependencySetEntries.$inferInsert;

/**
 * Rows per multi-VALUES INSERT. Each entry binds ~10 parameters, so 200 rows
 * stays far below SQLite's variable limit while keeping the statement count
 * low for a 1500-dependency lockfile.
 */
const INSERT_CHUNK = 200;

export interface CreateDependencySetInput {
	projectId: string;
	lockHash: string;
	manager: PackageManager;
	graph: DependencyGraph;
	/** Scan that first observed this lockfile hash (provenance only, no FK). */
	firstScanId: string;
}

export interface DependencyListFilters {
	q?: string;
	/** One or several dependency types; empty array = no filter. */
	depType?: DepType | readonly DepType[];
	direct?: boolean;
	/** One or several update kinds; empty array = no filter. */
	updateKind?: UpdateKind | readonly UpdateKind[];
	hasVuln?: boolean;
	workspace?: string;
	page: number;
	pageSize: number;
	sort?: 'name' | 'severity' | 'updateKind';
}

function asList<T>(value: T | readonly T[] | undefined): T[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? [...value] : [value as T];
}

export interface DependencyListRow {
	name: string;
	version: string;
	workspace: string;
	depType: DepType;
	isDirect: boolean;
	depth: number;
	declaredRange: string | null;
	currentVersion: string;
	wantedVersion: string | null;
	latestVersion: string | null;
	updateKind: UpdateKind;
	deprecated: boolean;
	maxSeverity: Severity | null;
	openFindings: number;
}

const SEVERITY_BY_RANK: Record<number, Severity> = {
	1: 'low',
	2: 'moderate',
	3: 'high',
	4: 'critical',
};

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
 * Content-addressed dependency snapshots. A set is keyed by
 * `(projectId, lockHash)`, so re-scanning an unchanged repository reuses the
 * existing set instead of writing a fresh copy of every entry.
 */
export function createDependencySetsStore(db: Db) {
	return {
		async findByLockHash(
			projectId: string,
			lockHash: string
		): Promise<DependencySetRow | null> {
			const row = await db.query.dependencySets.findFirst({
				where: and(
					eq(schema.dependencySets.projectId, projectId),
					eq(schema.dependencySets.lockHash, lockHash)
				),
			});
			return row ?? null;
		},

		async byId(setId: string): Promise<DependencySetRow | null> {
			const row = await db.query.dependencySets.findFirst({
				where: eq(schema.dependencySets.id, setId),
			});
			return row ?? null;
		},

		/**
		 * Insert the set and every entry in ONE transaction — a partially
		 * written set would otherwise be indistinguishable from a complete one
		 * on the next scan's `findByLockHash` hit.
		 */
		async create(
			input: CreateDependencySetInput
		): Promise<DependencySetRow> {
			const dependencies = input.graph.dependencies;
			const setRow: DependencySetRow = {
				id: id(),
				projectId: input.projectId,
				lockHash: input.lockHash,
				ecosystem: input.graph.ecosystem,
				warningsJson:
					input.graph.warnings.length === 0
						? null
						: JSON.stringify(
								input.graph.warnings.map((warning) =>
									warning.slice(0, 500)
								)
							),
				manager: input.manager,
				packageCount: dependencies.length,
				directCount: dependencies.filter(
					(dependency) => dependency.isDirect
				).length,
				createdAt: new Date(),
				firstScanId: input.firstScanId,
			};

			const entries: NewDependencySetEntry[] = dependencies.map(
				(dependency) => ({
					setId: setRow.id,
					name: dependency.name,
					version: dependency.version,
					workspace: dependency.workspace,
					depType: dependency.depType,
					isDirect: dependency.isDirect,
					depth: dependency.depth,
					declaredRange: dependency.declaredRange ?? null,
					peerDepsJson:
						dependency.peerDeps === undefined
							? null
							: JSON.stringify(dependency.peerDeps),
					resolved: dependency.resolved ?? null,
				})
			);

			db.transaction((tx) => {
				tx.insert(schema.dependencySets).values(setRow).run();
				for (const chunk of chunked(entries, INSERT_CHUNK)) {
					tx.insert(schema.dependencySetEntries)
						.values(chunk)
						.onConflictDoNothing()
						.run();
				}
			});

			return setRow;
		},

		async entriesForSet(
			setId: string,
			page?: { limit: number; offset: number }
		): Promise<DependencySetEntryRow[]> {
			const query = db
				.select()
				.from(schema.dependencySetEntries)
				.where(eq(schema.dependencySetEntries.setId, setId))
				.orderBy(schema.dependencySetEntries.id);
			if (page === undefined) return query;
			return query.limit(page.limit).offset(page.offset);
		},

		/** Distinct `(name, version)` pairs — the audit pass's input set. */
		async distinctNameVersions(
			setId: string
		): Promise<{ name: string; version: string }[]> {
			return db
				.selectDistinct({
					name: schema.dependencySetEntries.name,
					version: schema.dependencySetEntries.version,
				})
				.from(schema.dependencySetEntries)
				.where(eq(schema.dependencySetEntries.setId, setId));
		},

		async directCountsForSet(
			setId: string
		): Promise<{ total: number; direct: number }> {
			const [row] = await db
				.select({
					total: sql<number>`count(*)`,
					direct: sql<number>`sum(case when ${schema.dependencySetEntries.isDirect} then 1 else 0 end)`,
				})
				.from(schema.dependencySetEntries)
				.where(eq(schema.dependencySetEntries.setId, setId));
			return { total: row?.total ?? 0, direct: row?.direct ?? 0 };
		},

		/**
		 * The dependencies view: the last successful scan's entries LEFT
		 * JOINed onto current outdated state and a per-`(name, version)`
		 * rollup of open findings. Severity is aggregated as a rank in SQL
		 * (`max(case severity …)`) and mapped back to a label in JS — SQLite
		 * cannot order a text enum meaningfully on its own.
		 */
		async listWithStatus(
			projectId: string,
			setId: string,
			filters: DependencyListFilters
		): Promise<{ items: DependencyListRow[]; total: number }> {
			const entries = schema.dependencySetEntries;
			const status = schema.dependencyStatus;

			const findingAgg = db.$with('finding_agg').as(
				db
					.select({
						packageName: schema.findings.packageName,
						packageVersion: schema.findings.packageVersion,
						sevRank:
							sql<number>`max(case "findings"."severity" when 'critical' then 4 when 'high' then 3 when 'moderate' then 2 else 1 end)`.as(
								'sev_rank'
							),
						openFindings: sql<number>`count(*)`.as('open_findings'),
					})
					.from(schema.findings)
					.where(
						and(
							eq(schema.findings.projectId, projectId),
							eq(schema.findings.state, 'open')
						)
					)
					.groupBy(
						schema.findings.packageName,
						schema.findings.packageVersion
					)
			);

			// A status row is per (workspace, package) but a tree can hold the
			// same package at SEVERAL versions (uv forks per python version).
			// The row-level update kind therefore treats an entry that already
			// sits at `latest` as 'none', whatever the shared status row says.
			const rowUpdateKind = sql<UpdateKind>`case when ${status.latestVersion} is not null and ${entries.version} = ${status.latestVersion} then 'none' else coalesce(${status.updateKind}, 'none') end`;

			const clauses: (SQL | undefined)[] = [eq(entries.setId, setId)];
			if (filters.q !== undefined && filters.q !== '') {
				clauses.push(like(entries.name, `%${escapeLike(filters.q)}%`));
			}
			const depTypes = asList(filters.depType);
			if (depTypes.length > 0) {
				clauses.push(inArray(entries.depType, depTypes));
			}
			if (filters.direct !== undefined) {
				clauses.push(eq(entries.isDirect, filters.direct));
			}
			if (filters.workspace !== undefined) {
				clauses.push(eq(entries.workspace, filters.workspace));
			}
			const updateKinds = asList(filters.updateKind);
			if (updateKinds.length > 0) {
				clauses.push(
					sql`${rowUpdateKind} in (${sql.join(
						updateKinds.map((kind) => sql`${kind}`),
						sql`, `
					)})`
				);
			}
			if (filters.hasVuln === true) {
				clauses.push(sql`"finding_agg"."open_findings" > 0`);
			} else if (filters.hasVuln === false) {
				clauses.push(sql`"finding_agg"."open_findings" is null`);
			}
			const where = and(...clauses);

			const base = () =>
				db
					.with(findingAgg)
					.select({
						name: entries.name,
						version: entries.version,
						workspace: entries.workspace,
						depType: entries.depType,
						isDirect: entries.isDirect,
						depth: entries.depth,
						declaredRange: entries.declaredRange,
						wantedVersion: status.wantedVersion,
						latestVersion: status.latestVersion,
						updateKind: status.updateKind,
						deprecatedMessage: status.deprecatedMessage,
						sevRank: findingAgg.sevRank,
						openFindings: findingAgg.openFindings,
					})
					.from(entries)
					.leftJoin(
						status,
						and(
							eq(status.projectId, projectId),
							eq(status.workspace, entries.workspace),
							eq(status.packageName, entries.name)
						)
					)
					.leftJoin(
						findingAgg,
						and(
							eq(findingAgg.packageName, entries.name),
							eq(findingAgg.packageVersion, entries.version)
						)
					)
					.where(where);

			const order =
				filters.sort === 'severity'
					? [desc(findingAgg.sevRank), asc(entries.name)]
					: filters.sort === 'updateKind'
						? [
								sql`case "dependency_status"."update_kind" when 'major' then 0 when 'minor' then 1 when 'patch' then 2 else 3 end`,
								asc(entries.name),
							]
						: [asc(entries.name), asc(entries.version)];

			const rows = await base()
				.orderBy(...order)
				.limit(filters.pageSize)
				.offset((filters.page - 1) * filters.pageSize);

			const counted = await db
				.with(findingAgg)
				.select({ count: sql<number>`count(*)` })
				.from(entries)
				.leftJoin(
					status,
					and(
						eq(status.projectId, projectId),
						eq(status.workspace, entries.workspace),
						eq(status.packageName, entries.name)
					)
				)
				.leftJoin(
					findingAgg,
					and(
						eq(findingAgg.packageName, entries.name),
						eq(findingAgg.packageVersion, entries.version)
					)
				)
				.where(where);

			return {
				items: rows.map((row) => ({
					name: row.name,
					version: row.version,
					workspace: row.workspace,
					depType: row.depType,
					isDirect: row.isDirect,
					depth: row.depth,
					declaredRange: row.declaredRange,
					// The entry is authoritative for "which version sits here":
					// dependency_status holds ONE row per (workspace, package),
					// so when a tree carries two copies of a package its status
					// row describes only the shallowest. wanted/latest stay
					// meaningful (they are per package); `updateKind` is
					// relative to that representative copy.
					currentVersion: row.version,
					wantedVersion: row.wantedVersion ?? null,
					latestVersion: row.latestVersion ?? null,
					// Mirror `rowUpdateKind`: an entry already at `latest` has
					// no update, even when a sibling version of the package does.
					updateKind:
						row.latestVersion !== null &&
						row.version === row.latestVersion
							? 'none'
							: (row.updateKind ?? 'none'),
					deprecated:
						row.deprecatedMessage !== null &&
						row.deprecatedMessage !== undefined,
					maxSeverity:
						row.sevRank === null || row.sevRank === undefined
							? null
							: (SEVERITY_BY_RANK[row.sevRank] ?? null),
					openFindings: row.openFindings ?? 0,
				})),
				total: counted[0]?.count ?? 0,
			};
		},

		/** Every occurrence of one package in the set (all versions/workspaces). */
		async entriesForPackage(
			setId: string,
			name: string
		): Promise<DependencySetEntryRow[]> {
			return db
				.select()
				.from(schema.dependencySetEntries)
				.where(
					and(
						eq(schema.dependencySetEntries.setId, setId),
						eq(schema.dependencySetEntries.name, name)
					)
				)
				.limit(200);
		},

		async workspacesForSet(setId: string): Promise<string[]> {
			const rows = await db
				.selectDistinct({
					workspace: schema.dependencySetEntries.workspace,
				})
				.from(schema.dependencySetEntries)
				.where(eq(schema.dependencySetEntries.setId, setId));
			return rows.map((row) => row.workspace).sort();
		},

		/**
		 * Retention hook (used by B9's prune job): drop every set of this
		 * project that no scan still points at. Entries cascade.
		 */
		async deleteOrphans(
			projectId: string,
			referencedSetIds: readonly string[]
		): Promise<number> {
			const where =
				referencedSetIds.length === 0
					? eq(schema.dependencySets.projectId, projectId)
					: and(
							eq(schema.dependencySets.projectId, projectId),
							notInArray(schema.dependencySets.id, [
								...referencedSetIds,
							])
						);
			const deleted = await db
				.delete(schema.dependencySets)
				.where(where)
				.returning({ id: schema.dependencySets.id });
			return deleted.length;
		},
	};
}

export type DependencySetsStore = ReturnType<typeof createDependencySetsStore>;
