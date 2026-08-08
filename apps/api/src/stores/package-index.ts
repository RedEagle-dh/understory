import type {
	DepType,
	Ecosystem,
	Severity,
	UpdateKind,
} from '@workspace/audit-engine';
import { type Db, schema } from '@workspace/db';
import { and, asc, desc, eq, inArray, like, type SQL, sql } from 'drizzle-orm';

/**
 * The cross-project package index: "which of my repositories ship this
 * package, and at which versions".
 *
 * Everything else in the app is scoped to one project, which is the wrong
 * shape during an incident — when a package is compromised the question is
 * about the fleet, not about one repo. Every query here therefore starts from
 * the set of projects' CURRENT dependency snapshots (the last *successful*
 * scan's set), so a running or failed scan never removes a project from the
 * answer.
 */

export interface PackageSearchFilters {
	q?: string;
	ecosystem?: Ecosystem;
	/** Keep only packages that are a direct dependency somewhere. */
	direct?: boolean;
	hasVuln?: boolean;
	page: number;
	pageSize: number;
	sort?: 'name' | 'projects' | 'severity';
}

export interface PackageIndexRow {
	name: string;
	ecosystem: Ecosystem;
	projectCount: number;
	/** Projects where it is declared rather than pulled in transitively. */
	directProjectCount: number;
	versionCount: number;
	/** A sample of the versions in use, lowest first. */
	versions: string[];
	openFindings: number;
	affectedProjects: number;
	maxSeverity: Severity | null;
}

export interface PackageUsageRow {
	projectId: string;
	projectName: string;
	owner: string;
	repo: string;
	ecosystem: Ecosystem;
	version: string;
	/** Every workspace of that project holding this version. */
	workspaces: string[];
	depTypes: DepType[];
	isDirect: boolean;
	depth: number;
	declaredRange: string | null;
	latestVersion: string | null;
	updateKind: UpdateKind;
	openFindings: number;
	maxSeverity: Severity | null;
}

const SEVERITY_BY_RANK: Record<number, Severity> = {
	1: 'low',
	2: 'moderate',
	3: 'high',
	4: 'critical',
};

const SEVERITY_RANK: Record<Severity, number> = {
	low: 1,
	moderate: 2,
	high: 3,
	critical: 4,
};

/** Guard rail on the usage view; a package in a large fleet can have many rows. */
const MAX_USAGE_ENTRIES = 2000;

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function createPackageIndexStore(db: Db) {
	const entries = schema.dependencySetEntries;

	/**
	 * Each project's current snapshot. An INNER join on `lastSuccessScanId`
	 * drops projects that have never completed a scan — they genuinely have no
	 * known dependencies, and reporting them as "uses nothing" would be a lie
	 * rather than an omission.
	 */
	const currentSets = () =>
		db
			.select({
				projectId: schema.projects.id,
				projectName: schema.projects.name,
				owner: schema.projects.owner,
				repo: schema.projects.repo,
				setId: schema.scans.dependencySetId,
				ecosystem: schema.dependencySets.ecosystem,
			})
			.from(schema.projects)
			.innerJoin(
				schema.scans,
				eq(schema.scans.id, schema.projects.lastSuccessScanId)
			)
			.innerJoin(
				schema.dependencySets,
				eq(schema.dependencySets.id, schema.scans.dependencySetId)
			)
			.as('current_sets');

	/**
	 * Max open severity per (project, package). Keyed by project as well as
	 * name so the join below is exact rather than colliding an npm package
	 * with a PyPI package of the same name — and aggregated with `max`, which
	 * survives the row fan-out a `sum` could not (one package can appear in
	 * several workspaces of the same project).
	 */
	const severityByProjectPackage = () =>
		db
			.select({
				projectId: schema.findings.projectId,
				packageName: schema.findings.packageName,
				sevRank:
					sql<number>`max(case ${schema.findings.severity} when 'critical' then 4 when 'high' then 3 when 'moderate' then 2 else 1 end)`.as(
						'sev_rank'
					),
			})
			.from(schema.findings)
			.where(eq(schema.findings.state, 'open'))
			.groupBy(schema.findings.projectId, schema.findings.packageName)
			.as('severity_agg');

	return {
		/**
		 * One row per (package name, ecosystem) across the fleet.
		 *
		 * Deliberately three queries rather than one clever join: the exact
		 * finding counts cannot be summed in the same statement as the package
		 * aggregate without multiplying them by the number of workspace rows.
		 * The grouped query decides *which* packages and how they sort; the
		 * follow-ups fill in exact numbers for just the page.
		 */
		async search(
			filters: PackageSearchFilters
		): Promise<{ items: PackageIndexRow[]; total: number }> {
			const sets = currentSets();
			const severity = severityByProjectPackage();

			const clauses: (SQL | undefined)[] = [];
			if (filters.q !== undefined && filters.q.trim() !== '') {
				clauses.push(
					like(entries.name, `%${escapeLike(filters.q.trim())}%`)
				);
			}
			if (filters.ecosystem !== undefined) {
				clauses.push(eq(sets.ecosystem, filters.ecosystem));
			}
			const where = clauses.length === 0 ? undefined : and(...clauses);

			const havings: SQL[] = [];
			if (filters.direct === true) {
				havings.push(sql`max(${entries.isDirect}) = 1`);
			} else if (filters.direct === false) {
				havings.push(sql`max(${entries.isDirect}) = 0`);
			}
			if (filters.hasVuln === true) {
				havings.push(sql`max(${severity.sevRank}) is not null`);
			} else if (filters.hasVuln === false) {
				havings.push(sql`max(${severity.sevRank}) is null`);
			}
			const having =
				havings.length === 0
					? undefined
					: havings.reduce((left, right) => sql`${left} and ${right}`);

			const grouped = () =>
				db
					.select({
						name: entries.name,
						ecosystem: sets.ecosystem,
						projectCount: sql<number>`count(distinct ${sets.projectId})`,
						directProjectCount: sql<number>`count(distinct case when ${entries.isDirect} then ${sets.projectId} end)`,
						versionCount: sql<number>`count(distinct ${entries.version})`,
						sevRank: sql<
							number | null
						>`max(${severity.sevRank})`.as('max_sev_rank'),
					})
					.from(entries)
					.innerJoin(sets, eq(sets.setId, entries.setId))
					.leftJoin(
						severity,
						and(
							eq(severity.projectId, sets.projectId),
							eq(severity.packageName, entries.name)
						)
					)
					.where(where)
					.groupBy(entries.name, sets.ecosystem)
					.having(having);

			const order =
				filters.sort === 'projects'
					? [
							desc(sql`count(distinct ${sets.projectId})`),
							asc(entries.name),
						]
					: filters.sort === 'severity'
						? [
								desc(sql`max(${severity.sevRank})`),
								desc(sql`count(distinct ${sets.projectId})`),
								asc(entries.name),
							]
						: [asc(entries.name)];

			const rows = await grouped()
				.orderBy(...order)
				.limit(filters.pageSize)
				.offset((filters.page - 1) * filters.pageSize);

			const [counted] = await db
				.select({ count: sql<number>`count(*)` })
				.from(grouped().as('grouped'));

			const names = rows.map((row) => row.name);
			const [findingRollup, versionSamples] = await Promise.all([
				this.findingTotalsForNames(names),
				this.versionSamplesForNames(names),
			]);

			return {
				total: counted?.count ?? 0,
				items: rows.map((row) => {
					const totals = findingRollup.get(row.name);
					return {
						name: row.name,
						ecosystem: row.ecosystem,
						projectCount: row.projectCount,
						directProjectCount: row.directProjectCount,
						versionCount: row.versionCount,
						versions: versionSamples.get(row.name) ?? [],
						openFindings: totals?.openFindings ?? 0,
						affectedProjects: totals?.affectedProjects ?? 0,
						maxSeverity:
							row.sevRank === null || row.sevRank === undefined
								? null
								: (SEVERITY_BY_RANK[row.sevRank] ?? null),
					};
				}),
			};
		},

		/** Exact open-finding totals for a page of package names. */
		async findingTotalsForNames(
			names: readonly string[]
		): Promise<
			Map<string, { openFindings: number; affectedProjects: number }>
		> {
			const out = new Map<
				string,
				{ openFindings: number; affectedProjects: number }
			>();
			if (names.length === 0) return out;
			const rows = await db
				.select({
					packageName: schema.findings.packageName,
					openFindings: sql<number>`count(*)`,
					affectedProjects: sql<number>`count(distinct ${schema.findings.projectId})`,
				})
				.from(schema.findings)
				.where(
					and(
						eq(schema.findings.state, 'open'),
						inArray(schema.findings.packageName, [...names])
					)
				)
				.groupBy(schema.findings.packageName);
			for (const row of rows) {
				out.set(row.packageName, {
					openFindings: row.openFindings,
					affectedProjects: row.affectedProjects,
				});
			}
			return out;
		},

		/** Up to eight distinct in-use versions per name, for the list preview. */
		async versionSamplesForNames(
			names: readonly string[]
		): Promise<Map<string, string[]>> {
			const out = new Map<string, string[]>();
			if (names.length === 0) return out;
			const sets = currentSets();
			const rows = await db
				.selectDistinct({
					name: entries.name,
					version: entries.version,
				})
				.from(entries)
				.innerJoin(sets, eq(sets.setId, entries.setId))
				.where(inArray(entries.name, [...names]))
				.orderBy(asc(entries.name), asc(entries.version));
			for (const row of rows) {
				const bucket = out.get(row.name);
				if (bucket === undefined) out.set(row.name, [row.version]);
				else if (bucket.length < 8) bucket.push(row.version);
			}
			return out;
		},

		/**
		 * Every project shipping `name`, one row per (project, version).
		 *
		 * Rows are folded in JS rather than with `group_concat`: SQLite only
		 * accepts a single argument to the distinct form, and the workspace and
		 * dep-type lists both need one.
		 */
		async usages(
			name: string,
			options: { ecosystem?: Ecosystem } = {}
		): Promise<{ items: PackageUsageRow[]; truncated: boolean }> {
			const sets = currentSets();
			const rows = await db
				.select({
					projectId: sets.projectId,
					projectName: sets.projectName,
					owner: sets.owner,
					repo: sets.repo,
					ecosystem: sets.ecosystem,
					version: entries.version,
					workspace: entries.workspace,
					depType: entries.depType,
					isDirect: entries.isDirect,
					depth: entries.depth,
					declaredRange: entries.declaredRange,
				})
				.from(entries)
				.innerJoin(sets, eq(sets.setId, entries.setId))
				.where(
					options.ecosystem === undefined
						? eq(entries.name, name)
						: and(
								eq(entries.name, name),
								eq(sets.ecosystem, options.ecosystem)
							)
				)
				.orderBy(asc(sets.projectName), asc(entries.version))
				.limit(MAX_USAGE_ENTRIES + 1);

			const truncated = rows.length > MAX_USAGE_ENTRIES;
			const usable = truncated ? rows.slice(0, MAX_USAGE_ENTRIES) : rows;

			const projectIds = [...new Set(usable.map((row) => row.projectId))];
			const [statusRows, findingRows] = await Promise.all([
				projectIds.length === 0
					? []
					: db
							.select({
								projectId: schema.dependencyStatus.projectId,
								workspace: schema.dependencyStatus.workspace,
								latestVersion:
									schema.dependencyStatus.latestVersion,
								updateKind: schema.dependencyStatus.updateKind,
							})
							.from(schema.dependencyStatus)
							.where(
								and(
									eq(
										schema.dependencyStatus.packageName,
										name
									),
									inArray(
										schema.dependencyStatus.projectId,
										projectIds
									)
								)
							),
				projectIds.length === 0
					? []
					: db
							.select({
								projectId: schema.findings.projectId,
								packageVersion: schema.findings.packageVersion,
								severity: schema.findings.severity,
								count: sql<number>`count(*)`,
							})
							.from(schema.findings)
							.where(
								and(
									eq(schema.findings.state, 'open'),
									eq(schema.findings.packageName, name),
									inArray(
										schema.findings.projectId,
										projectIds
									)
								)
							)
							.groupBy(
								schema.findings.projectId,
								schema.findings.packageVersion,
								schema.findings.severity
							),
			]);

			// One status row per (project, workspace); the representative for a
			// (project, version) group is whichever workspace reports a latest.
			const statusByProject = new Map<
				string,
				{ latestVersion: string | null; updateKind: UpdateKind }
			>();
			for (const row of statusRows) {
				const existing = statusByProject.get(row.projectId);
				if (existing === undefined || existing.latestVersion === null) {
					statusByProject.set(row.projectId, {
						latestVersion: row.latestVersion,
						updateKind: row.updateKind,
					});
				}
			}

			const findingsByKey = new Map<
				string,
				{ count: number; severity: Severity }
			>();
			for (const row of findingRows) {
				const key = `${row.projectId}\u0000${row.packageVersion}`;
				const existing = findingsByKey.get(key);
				if (existing === undefined) {
					findingsByKey.set(key, {
						count: row.count,
						severity: row.severity,
					});
					continue;
				}
				existing.count += row.count;
				if (
					SEVERITY_RANK[row.severity] >
					SEVERITY_RANK[existing.severity]
				) {
					existing.severity = row.severity;
				}
			}

			const grouped = new Map<string, PackageUsageRow>();
			for (const row of usable) {
				const key = `${row.projectId}\u0000${row.version}`;
				const status = statusByProject.get(row.projectId);
				const found = findingsByKey.get(key);
				const existing = grouped.get(key);
				if (existing === undefined) {
					grouped.set(key, {
						projectId: row.projectId,
						projectName: row.projectName,
						owner: row.owner,
						repo: row.repo,
						ecosystem: row.ecosystem,
						version: row.version,
						workspaces: [row.workspace],
						depTypes: [row.depType],
						isDirect: row.isDirect,
						depth: row.depth,
						declaredRange: row.declaredRange,
						// An entry already sitting at `latest` has no update,
						// whatever the shared status row says about a sibling
						// copy at a different version.
						latestVersion: status?.latestVersion ?? null,
						updateKind:
							status?.latestVersion != null &&
							status.latestVersion === row.version
								? 'none'
								: (status?.updateKind ?? 'none'),
						openFindings: found?.count ?? 0,
						maxSeverity: found?.severity ?? null,
					});
					continue;
				}
				if (!existing.workspaces.includes(row.workspace)) {
					existing.workspaces.push(row.workspace);
				}
				if (!existing.depTypes.includes(row.depType)) {
					existing.depTypes.push(row.depType);
				}
				existing.isDirect = existing.isDirect || row.isDirect;
				existing.depth = Math.min(existing.depth, row.depth);
				existing.declaredRange ??= row.declaredRange;
			}

			return { items: [...grouped.values()], truncated };
		},
	};
}

export type PackageIndexStore = ReturnType<typeof createPackageIndexStore>;
