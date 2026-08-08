import type { DepType, FixType, Severity } from '@workspace/audit-engine';
import { type Db, id, schema } from '@workspace/db';
import { and, desc, eq, inArray, like, ne, or, type SQL, sql } from 'drizzle-orm';

export type FindingRow = typeof schema.findings.$inferSelect;
export type FindingState = FindingRow['state'];

const INSERT_CHUNK = 200;

export interface FindingMatch {
	advisoryId: string;
	packageName: string;
	packageVersion: string;
	workspace: string;
	severity: Severity;
	isDirect: boolean;
	depType: DepType;
	fixedIn: string | null;
	fixType: FixType;
	fixWithinRange: boolean | null;
}

export interface FindingFilters {
	severity?: readonly Severity[];
	state?: readonly FindingState[];
	isDirect?: boolean;
	hasFix?: boolean;
	q?: string;
	page: number;
	pageSize: number;
}

export interface FindingWithAdvisory {
	finding: FindingRow;
	advisorySummary: string;
	advisoryUrl: string | null;
	advisoryCvssScore: number | null;
}

/** Cross-project triage row: the finding, who it belongs to, and how urgent it is. */
export interface GlobalFindingRow extends FindingWithAdvisory {
	projectName: string;
	owner: string;
	repo: string;
	epssScore: number | null;
	epssPercentile: number | null;
	kevAddedAt: Date | null;
	kevKnownRansomware: boolean | null;
}

export interface GlobalFindingFilters {
	severity?: readonly Severity[];
	state?: readonly FindingState[];
	isDirect?: boolean;
	hasFix?: boolean;
	/** Restrict to one project; omit for the whole fleet. */
	projectId?: string;
	/** Only findings CISA lists as exploited in the wild. */
	kevOnly?: boolean;
	q?: string;
	sort?: 'risk' | 'severity' | 'firstSeen';
	page: number;
	pageSize: number;
}

export interface SeverityCountsResult {
	critical: number;
	high: number;
	moderate: number;
	low: number;
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
 * The diff engine. `syncForScan` is the only writer of the lifecycle columns;
 * everything the UI and the notifier need afterwards is an indexed read
 * (`firstSeenScanId = N`, `resolvedScanId = N`, `state = 'open'`).
 */
export function createFindingsStore(db: Db) {
	function findingWhere(
		projectId: string,
		filters: FindingFilters
	): SQL | undefined {
		const clauses: (SQL | undefined)[] = [
			eq(schema.findings.projectId, projectId),
		];
		if (filters.state !== undefined && filters.state.length > 0) {
			clauses.push(inArray(schema.findings.state, [...filters.state]));
		}
		if (filters.severity !== undefined && filters.severity.length > 0) {
			clauses.push(
				inArray(schema.findings.severity, [...filters.severity])
			);
		}
		if (filters.isDirect !== undefined) {
			clauses.push(eq(schema.findings.isDirect, filters.isDirect));
		}
		if (filters.hasFix === true) {
			clauses.push(sql`${schema.findings.fixedIn} is not null`);
		} else if (filters.hasFix === false) {
			clauses.push(sql`${schema.findings.fixedIn} is null`);
		}
		if (filters.q !== undefined && filters.q !== '') {
			const pattern = `%${escapeLike(filters.q)}%`;
			clauses.push(
				or(
					like(schema.findings.packageName, pattern),
					like(schema.findings.advisoryId, pattern)
				)
			);
		}
		return and(...clauses);
	}

	async function joinedList(
		where: SQL | undefined,
		limit: number,
		offset: number
	): Promise<FindingWithAdvisory[]> {
		const rows = await db
			.select({
				finding: schema.findings,
				advisorySummary: schema.advisories.summary,
				advisoryUrl: schema.advisories.url,
				advisoryCvssScore: schema.advisories.cvssScore,
			})
			.from(schema.findings)
			.innerJoin(
				schema.advisories,
				eq(schema.advisories.id, schema.findings.advisoryId)
			)
			.where(where)
			.orderBy(
				sql`case ${schema.findings.severity} when 'critical' then 0 when 'high' then 1 when 'moderate' then 2 else 3 end`,
				schema.findings.packageName
			)
			.limit(limit)
			.offset(offset);
		return rows;
	}

	return {
		/**
		 * One transaction, three phases:
		 *  1. upsert every match — new rows carry `firstSeenScanId = scanId`
		 *     (the "new finding" signal); an existing *open* row only refreshes
		 *     `lastSeen*` + severity/fix data; an existing *resolved* row
		 *     re-opens and restarts its first-seen pointer (a regression is a
		 *     new finding); an `ignored` row stays ignored.
		 *  2. auto-unignore rows whose `ignoreUntil` has passed.
		 *  3. resolve everything still `open` that this scan did not touch.
		 */
		async syncForScan(
			projectId: string,
			scanId: string,
			now: Date,
			matches: readonly FindingMatch[]
		): Promise<{ new: number; resolved: number }> {
			let resolved = 0;

			db.transaction((tx) => {
				const rows = matches.map((match) => ({
					id: id(),
					projectId,
					advisoryId: match.advisoryId,
					packageName: match.packageName,
					packageVersion: match.packageVersion,
					workspace: match.workspace,
					severity: match.severity,
					isDirect: match.isDirect,
					depType: match.depType,
					state: 'open' as const,
					fixedIn: match.fixedIn,
					fixType: match.fixType,
					fixWithinRange: match.fixWithinRange,
					firstSeenScanId: scanId,
					firstSeenAt: now,
					lastSeenScanId: scanId,
					lastSeenAt: now,
				}));

				for (const chunk of chunked(rows, INSERT_CHUNK)) {
					tx.insert(schema.findings)
						.values(chunk)
						.onConflictDoUpdate({
							target: [
								schema.findings.projectId,
								schema.findings.advisoryId,
								schema.findings.packageName,
								schema.findings.packageVersion,
							],
							set: {
								severity: sql`excluded.severity`,
								isDirect: sql`excluded.is_direct`,
								depType: sql`excluded.dep_type`,
								fixedIn: sql`excluded.fixed_in`,
								fixType: sql`excluded.fix_type`,
								fixWithinRange: sql`excluded.fix_within_range`,
								workspace: sql`excluded.workspace`,
								state: sql`case when "findings"."state" = 'ignored' then 'ignored' else 'open' end`,
								firstSeenScanId: sql`case when "findings"."state" = 'resolved' then excluded.first_seen_scan_id else "findings"."first_seen_scan_id" end`,
								firstSeenAt: sql`case when "findings"."state" = 'resolved' then excluded.first_seen_at else "findings"."first_seen_at" end`,
								lastSeenScanId: sql`excluded.last_seen_scan_id`,
								lastSeenAt: sql`excluded.last_seen_at`,
								resolvedScanId: sql`case when "findings"."state" = 'resolved' then null else "findings"."resolved_scan_id" end`,
								resolvedAt: sql`case when "findings"."state" = 'resolved' then null else "findings"."resolved_at" end`,
							},
						})
						.run();
				}

				tx.update(schema.findings)
					.set({
						state: 'open',
						ignoredBy: null,
						ignoredAt: null,
						ignoreReason: null,
						ignoreUntil: null,
					})
					.where(
						and(
							eq(schema.findings.projectId, projectId),
							eq(schema.findings.state, 'ignored'),
							sql`${schema.findings.ignoreUntil} is not null`,
							sql`${schema.findings.ignoreUntil} < ${now.getTime()}`
						)
					)
					.run();

				const closed = tx
					.update(schema.findings)
					.set({
						state: 'resolved',
						resolvedScanId: scanId,
						resolvedAt: now,
					})
					.where(
						and(
							eq(schema.findings.projectId, projectId),
							eq(schema.findings.state, 'open'),
							ne(schema.findings.lastSeenScanId, scanId)
						)
					)
					.returning({ id: schema.findings.id })
					.all();
				resolved = closed.length;
			});

			// `scanId` is unique per scan, so this is an exact count of the
			// rows the upsert phase stamped as first seen here.
			const [created] = await db
				.select({ count: sql<number>`count(*)` })
				.from(schema.findings)
				.where(
					and(
						eq(schema.findings.projectId, projectId),
						eq(schema.findings.firstSeenScanId, scanId)
					)
				);

			return { new: created?.count ?? 0, resolved };
		},

		async listForProject(
			projectId: string,
			filters: FindingFilters
		): Promise<{ items: FindingWithAdvisory[]; total: number }> {
			const where = findingWhere(projectId, filters);
			const [items, [total]] = await Promise.all([
				joinedList(
					where,
					filters.pageSize,
					(filters.page - 1) * filters.pageSize
				),
				db
					.select({ count: sql<number>`count(*)` })
					.from(schema.findings)
					.where(where),
			]);
			return { items, total: total?.count ?? 0 };
		},

		async byId(findingId: string): Promise<FindingRow | null> {
			const row = await db.query.findings.findFirst({
				where: eq(schema.findings.id, findingId),
			});
			return row ?? null;
		},

		async ignore(
			findingId: string,
			input: {
				actorUserId: string;
				reason: string;
				ignoreUntil: Date | null;
			}
		): Promise<FindingRow | null> {
			const [row] = await db
				.update(schema.findings)
				.set({
					state: 'ignored',
					ignoredBy: input.actorUserId,
					ignoredAt: new Date(),
					ignoreReason: input.reason,
					ignoreUntil: input.ignoreUntil,
				})
				.where(eq(schema.findings.id, findingId))
				.returning();
			return row ?? null;
		},

		async unignore(findingId: string): Promise<FindingRow | null> {
			const [row] = await db
				.update(schema.findings)
				.set({
					state: 'open',
					ignoredBy: null,
					ignoredAt: null,
					ignoreReason: null,
					ignoreUntil: null,
				})
				.where(
					and(
						eq(schema.findings.id, findingId),
						eq(schema.findings.state, 'ignored')
					)
				)
				.returning();
			return row ?? null;
		},

		async openCounts(projectId: string): Promise<SeverityCountsResult> {
			const rows = await db
				.select({
					severity: schema.findings.severity,
					count: sql<number>`count(*)`,
				})
				.from(schema.findings)
				.where(
					and(
						eq(schema.findings.projectId, projectId),
						eq(schema.findings.state, 'open')
					)
				)
				.groupBy(schema.findings.severity);
			const counts: SeverityCountsResult = {
				critical: 0,
				high: 0,
				moderate: 0,
				low: 0,
			};
			for (const row of rows) counts[row.severity] = row.count;
			return counts;
		},

		/**
		 * One grouped query across every project — the projects list would
		 * otherwise issue N severity rollups.
		 */
		async openCountsByProject(): Promise<
			Map<string, SeverityCountsResult>
		> {
			const rows = await db
				.select({
					projectId: schema.findings.projectId,
					severity: schema.findings.severity,
					count: sql<number>`count(*)`,
				})
				.from(schema.findings)
				.where(eq(schema.findings.state, 'open'))
				.groupBy(schema.findings.projectId, schema.findings.severity);
			const out = new Map<string, SeverityCountsResult>();
			for (const row of rows) {
				let counts = out.get(row.projectId);
				if (counts === undefined) {
					counts = { critical: 0, high: 0, moderate: 0, low: 0 };
					out.set(row.projectId, counts);
				}
				counts[row.severity] = row.count;
			}
			return out;
		},

		/** Max open severity + open count per `(packageName, packageVersion)`. */
		async openByPackage(
			projectId: string
		): Promise<Map<string, { severity: Severity; count: number }>> {
			const rows = await db
				.select({
					packageName: schema.findings.packageName,
					packageVersion: schema.findings.packageVersion,
					severity: schema.findings.severity,
					count: sql<number>`count(*)`,
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
					schema.findings.packageVersion,
					schema.findings.severity
				);
			const rank: Record<Severity, number> = {
				low: 0,
				moderate: 1,
				high: 2,
				critical: 3,
			};
			const out = new Map<
				string,
				{ severity: Severity; count: number }
			>();
			for (const row of rows) {
				const key = `${row.packageName} ${row.packageVersion}`;
				const current = out.get(key);
				if (current === undefined) {
					out.set(key, { severity: row.severity, count: row.count });
					continue;
				}
				current.count += row.count;
				if (rank[row.severity] > rank[current.severity]) {
					current.severity = row.severity;
				}
			}
			return out;
		},

		async newForScan(scanId: string): Promise<FindingWithAdvisory[]> {
			return joinedList(
				and(
					eq(schema.findings.firstSeenScanId, scanId),
					ne(schema.findings.state, 'resolved')
				),
				500,
				0
			);
		},

		async resolvedForScan(scanId: string): Promise<FindingWithAdvisory[]> {
			return joinedList(
				eq(schema.findings.resolvedScanId, scanId),
				500,
				0
			);
		},

		/**
		 * Open findings for a batch of package names, grouped by name — one
		 * query for a whole PR plan instead of one per selected package.
		 */
		async openForPackageNames(
			projectId: string,
			packageNames: readonly string[]
		): Promise<Map<string, FindingRow[]>> {
			const out = new Map<string, FindingRow[]>();
			if (packageNames.length === 0) return out;
			const rows = await db
				.select()
				.from(schema.findings)
				.where(
					and(
						eq(schema.findings.projectId, projectId),
						eq(schema.findings.state, 'open'),
						inArray(schema.findings.packageName, [...packageNames])
					)
				);
			for (const row of rows) {
				const bucket = out.get(row.packageName);
				if (bucket === undefined) out.set(row.packageName, [row]);
				else bucket.push(row);
			}
			return out;
		},

		/** Open findings pinned to any of the given advisories — `advisory.refresh`'s re-evaluation input. */
		async openForAdvisoryIds(
			advisoryIds: readonly string[]
		): Promise<FindingRow[]> {
			if (advisoryIds.length === 0) return [];
			const out: FindingRow[] = [];
			for (const chunk of chunked(advisoryIds, INSERT_CHUNK)) {
				const rows = await db
					.select()
					.from(schema.findings)
					.where(
						and(
							eq(schema.findings.state, 'open'),
							inArray(schema.findings.advisoryId, chunk)
						)
					);
				out.push(...rows);
			}
			return out;
		},

		/**
		 * Resolves findings outside the normal scan lifecycle: `advisory.refresh`
		 * calls this when a package version no longer matches any of an
		 * advisory's (updated) ranges, or the advisory was withdrawn.
		 * `resolvedScanId` stays `null` — no scan produced this resolution, so
		 * there is no scan id to point at; `resolvedAt` is the only record of
		 * when it happened.
		 */
		async resolveByIds(
			findingIds: readonly string[],
			resolvedAt: Date
		): Promise<number> {
			if (findingIds.length === 0) return 0;
			let count = 0;
			for (const chunk of chunked(findingIds, INSERT_CHUNK)) {
				const rows = await db
					.update(schema.findings)
					.set({
						state: 'resolved',
						resolvedAt,
						resolvedScanId: null,
					})
					.where(inArray(schema.findings.id, chunk))
					.returning({ id: schema.findings.id });
				count += rows.length;
			}
			return count;
		},

		/** Bulk severity propagation when `advisory.refresh` re-evaluates an advisory whose severity changed. */
		async updateSeverity(
			findingIds: readonly string[],
			severity: Severity
		): Promise<number> {
			if (findingIds.length === 0) return 0;
			let count = 0;
			for (const chunk of chunked(findingIds, INSERT_CHUNK)) {
				const rows = await db
					.update(schema.findings)
					.set({ severity })
					.where(inArray(schema.findings.id, chunk))
					.returning({ id: schema.findings.id });
				count += rows.length;
			}
			return count;
		},

		/**
		 * The global inbox: open findings across every project, newest and
		 * most urgent first.
		 *
		 * `risk` ordering is deliberately not severity: CISA's KEV catalogue
		 * lists vulnerabilities *observed* being exploited, and an EPSS score
		 * estimates the probability of exploitation in the next 30 days. A
		 * moderate that attackers are actively using outranks a critical that
		 * nobody has ever weaponised, so both signals sort ahead of the CVSS
		 * label. Advisories with no score sort last rather than as zero — "not
		 * scored" is not "safe".
		 */
		async listGlobal(
			filters: GlobalFindingFilters
		): Promise<{ items: GlobalFindingRow[]; total: number }> {
			const clauses: (SQL | undefined)[] = [];
			if (filters.projectId !== undefined) {
				clauses.push(eq(schema.findings.projectId, filters.projectId));
			}
			clauses.push(
				inArray(schema.findings.state, [
					...(filters.state === undefined || filters.state.length === 0
						? (['open'] as const)
						: filters.state),
				])
			);
			if (filters.severity !== undefined && filters.severity.length > 0) {
				clauses.push(
					inArray(schema.findings.severity, [...filters.severity])
				);
			}
			if (filters.isDirect !== undefined) {
				clauses.push(eq(schema.findings.isDirect, filters.isDirect));
			}
			if (filters.hasFix === true) {
				clauses.push(sql`${schema.findings.fixedIn} is not null`);
			} else if (filters.hasFix === false) {
				clauses.push(sql`${schema.findings.fixedIn} is null`);
			}
			if (filters.kevOnly === true) {
				clauses.push(sql`${schema.advisories.kevAddedAt} is not null`);
			}
			if (filters.q !== undefined && filters.q !== '') {
				const pattern = `%${escapeLike(filters.q)}%`;
				clauses.push(
					or(
						like(schema.findings.packageName, pattern),
						like(schema.findings.advisoryId, pattern),
						like(schema.projects.name, pattern)
					)
				);
			}
			const where = and(...clauses);

			const severityRank = sql`case ${schema.findings.severity} when 'critical' then 0 when 'high' then 1 when 'moderate' then 2 else 3 end`;
			const order =
				filters.sort === 'firstSeen'
					? [desc(schema.findings.firstSeenAt)]
					: filters.sort === 'severity'
						? [severityRank, desc(schema.findings.firstSeenAt)]
						: [
								sql`case when ${schema.advisories.kevAddedAt} is not null then 0 else 1 end`,
								sql`${schema.advisories.epssScore} is null`,
								desc(schema.advisories.epssScore),
								severityRank,
							];

			const base = () =>
				db
					.select({
						finding: schema.findings,
						advisorySummary: schema.advisories.summary,
						advisoryUrl: schema.advisories.url,
						advisoryCvssScore: schema.advisories.cvssScore,
						epssScore: schema.advisories.epssScore,
						epssPercentile: schema.advisories.epssPercentile,
						kevAddedAt: schema.advisories.kevAddedAt,
						kevKnownRansomware: schema.advisories.kevKnownRansomware,
						projectName: schema.projects.name,
						owner: schema.projects.owner,
						repo: schema.projects.repo,
					})
					.from(schema.findings)
					.innerJoin(
						schema.advisories,
						eq(schema.advisories.id, schema.findings.advisoryId)
					)
					.innerJoin(
						schema.projects,
						eq(schema.projects.id, schema.findings.projectId)
					)
					.where(where);

			const [items, [total]] = await Promise.all([
				base()
					.orderBy(...order)
					.limit(filters.pageSize)
					.offset((filters.page - 1) * filters.pageSize),
				db
					.select({ count: sql<number>`count(*)` })
					.from(schema.findings)
					.innerJoin(
						schema.advisories,
						eq(schema.advisories.id, schema.findings.advisoryId)
					)
					.innerJoin(
						schema.projects,
						eq(schema.projects.id, schema.findings.projectId)
					)
					.where(where),
			]);

			return { items, total: total?.count ?? 0 };
		},

		/** Fleet-wide open counts by severity, plus the exploited-in-the-wild tally. */
		async globalOpenCounts(): Promise<
			SeverityCountsResult & { kev: number; projects: number }
		> {
			const [bySeverity, [extras]] = await Promise.all([
				db
					.select({
						severity: schema.findings.severity,
						count: sql<number>`count(*)`,
					})
					.from(schema.findings)
					.where(eq(schema.findings.state, 'open'))
					.groupBy(schema.findings.severity),
				db
					.select({
						kev: sql<number>`sum(case when ${schema.advisories.kevAddedAt} is not null then 1 else 0 end)`,
						projects: sql<number>`count(distinct ${schema.findings.projectId})`,
					})
					.from(schema.findings)
					.innerJoin(
						schema.advisories,
						eq(schema.advisories.id, schema.findings.advisoryId)
					)
					.where(eq(schema.findings.state, 'open')),
			]);

			const counts = {
				critical: 0,
				high: 0,
				moderate: 0,
				low: 0,
				kev: extras?.kev ?? 0,
				projects: extras?.projects ?? 0,
			};
			for (const row of bySeverity) counts[row.severity] = row.count;
			return counts;
		},

		async listForPackage(
			projectId: string,
			packageName: string
		): Promise<FindingWithAdvisory[]> {
			return joinedList(
				and(
					eq(schema.findings.projectId, projectId),
					eq(schema.findings.packageName, packageName)
				),
				200,
				0
			);
		},
	};
}

export type FindingsStore = ReturnType<typeof createFindingsStore>;
