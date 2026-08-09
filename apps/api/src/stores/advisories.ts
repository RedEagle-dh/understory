import {
	type AdvisoryRange,
	compareSeverity,
	type Ecosystem,
	type MergedAdvisory,
	type Severity,
} from '@workspace/audit-engine';
import { type Db, schema } from '@workspace/db';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';

export type AdvisoryRow = typeof schema.advisories.$inferSelect;
export type AdvisoryRangeRow = typeof schema.advisoryRanges.$inferSelect;
export type AdvisorySourceRow = typeof schema.advisorySources.$inferSelect;

/** Keeps `IN (...)` parameter lists well inside SQLite's variable limit. */
const IN_CHUNK = 400;

export interface PackageRangeMatch {
	advisoryId: string;
	vulnerableRange: string;
	firstPatched: string | null;
	severity: Severity;
}

export interface AdvisoryDetail {
	advisory: AdvisoryRow;
	aliases: string[];
	ranges: AdvisoryRangeRow[];
	sources: AdvisorySourceRow[];
}

function chunked<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

function toDate(value: string | undefined): Date | null {
	if (value === undefined || value === '') return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : new Date(parsed);
}

function earlier(a: Date | null, b: Date | null): Date | null {
	if (a === null) return b;
	if (b === null) return a;
	return a <= b ? a : b;
}

function later(a: Date | null, b: Date | null): Date | null {
	if (a === null) return b;
	if (b === null) return a;
	return a >= b ? a : b;
}

/**
 * Global advisory storage. `mergeAdvisories` already reconciles the sources of
 * a single scan; this store handles the *cross-run* merge, where a GHSA stored
 * last week must absorb a CVE record that only now revealed the alias link.
 */
export function createAdvisoriesStore(db: Db) {
	async function loadAliasIndex(
		ids: readonly string[]
	): Promise<Map<string, string>> {
		const index = new Map<string, string>();
		for (const chunk of chunked([...new Set(ids)], IN_CHUNK)) {
			const rows = await db
				.select()
				.from(schema.advisoryAliases)
				.where(inArray(schema.advisoryAliases.alias, chunk));
			for (const row of rows) index.set(row.alias, row.advisoryId);
		}
		return index;
	}

	async function loadRows(
		ids: readonly string[]
	): Promise<Map<string, AdvisoryRow>> {
		const index = new Map<string, AdvisoryRow>();
		for (const chunk of chunked([...new Set(ids)], IN_CHUNK)) {
			const rows = await db
				.select()
				.from(schema.advisories)
				.where(inArray(schema.advisories.id, chunk));
			for (const row of rows) index.set(row.id, row);
		}
		return index;
	}

	return {
		/**
		 * Insert or merge every advisory. The canonical row is resolved by
		 * looking each incoming id AND alias up in `advisory_aliases`: when an
		 * alias already belongs to a row under a *different* canonical id, that
		 * existing row wins and the incoming record is merged into it (worst
		 * severity, earliest publish, latest modify, npm prose preferred).
		 */
		async upsertMerged(advisories: readonly MergedAdvisory[]): Promise<{
			inserted: number;
			updated: number;
		}> {
			if (advisories.length === 0) return { inserted: 0, updated: 0 };

			const candidateIds = advisories.flatMap((advisory) => [
				advisory.id,
				...advisory.aliases,
			]);
			const aliasIndex = await loadAliasIndex(candidateIds);
			const rowIndex = await loadRows([
				...candidateIds,
				...aliasIndex.values(),
			]);

			let inserted = 0;
			let updated = 0;
			const now = new Date();

			db.transaction((tx) => {
				for (const advisory of advisories) {
					const ids = [advisory.id, ...advisory.aliases];
					const canonicalId =
						ids.find((candidate) => rowIndex.has(candidate)) ??
						ids
							.map((candidate) => aliasIndex.get(candidate))
							.find(
								(candidate): candidate is string =>
									candidate !== undefined
							) ??
						advisory.id;

					const existing = rowIndex.get(canonicalId) ?? null;
					const preferNew =
						existing === null ||
						advisory.sources.some(
							(source) => source.source === 'npm'
						);

					const severity: Severity =
						existing === null
							? advisory.severity
							: compareSeverity(
										advisory.severity,
										existing.severity
									) > 0
								? advisory.severity
								: existing.severity;

					const cweIds = new Set<string>(advisory.cweIds);
					if (existing?.cweIdsJson != null) {
						try {
							for (const cwe of JSON.parse(
								existing.cweIdsJson
							) as string[]) {
								cweIds.add(cwe);
							}
						} catch {
							// A corrupt cache of CWE ids must not fail a scan.
						}
					}

					const row: AdvisoryRow = {
						id: canonicalId,
						summary:
							preferNew && advisory.summary !== ''
								? advisory.summary
								: (existing?.summary ?? advisory.summary),
						details:
							(preferNew ? advisory.details : undefined) ??
							existing?.details ??
							advisory.details ??
							null,
						severity,
						cvssScore:
							advisory.cvssScore ?? existing?.cvssScore ?? null,
						cvssVector:
							advisory.cvssVector ?? existing?.cvssVector ?? null,
						cweIdsJson: JSON.stringify([...cweIds].sort()),
						url:
							(preferNew ? advisory.url : undefined) ??
							existing?.url ??
							advisory.url ??
							null,
						publishedAt: earlier(
							toDate(advisory.publishedAt),
							existing?.publishedAt ?? null
						),
						modifiedAt: later(
							toDate(advisory.modifiedAt),
							existing?.modifiedAt ?? null
						),
						withdrawnAt:
							toDate(advisory.withdrawnAt) ??
							existing?.withdrawnAt ??
							null,
						rawJson: JSON.stringify(advisory.raw ?? null),
						updatedAt: now,
						// Owned by the threat-intel job, never by a scan. These
						// are carried over so `rowIndex` stays an accurate
						// mirror of the row; the upsert's `set` clause below
						// deliberately omits them, so a scan can neither write
						// nor clear them.
						epssScore: existing?.epssScore ?? null,
						epssPercentile: existing?.epssPercentile ?? null,
						kevAddedAt: existing?.kevAddedAt ?? null,
						kevKnownRansomware:
							existing?.kevKnownRansomware ?? null,
						threatIntelUpdatedAt:
							existing?.threatIntelUpdatedAt ?? null,
					};

					tx.insert(schema.advisories)
						.values(row)
						.onConflictDoUpdate({
							target: schema.advisories.id,
							set: {
								summary: row.summary,
								details: row.details,
								severity: row.severity,
								cvssScore: row.cvssScore,
								cvssVector: row.cvssVector,
								cweIdsJson: row.cweIdsJson,
								url: row.url,
								publishedAt: row.publishedAt,
								modifiedAt: row.modifiedAt,
								withdrawnAt: row.withdrawnAt,
								rawJson: row.rawJson,
								updatedAt: row.updatedAt,
							},
						})
						.run();

					if (existing === null) inserted += 1;
					else updated += 1;
					rowIndex.set(canonicalId, row);

					// Self-alias included: it makes `advisoryById` a single
					// lookup regardless of which id the caller holds.
					const aliasRows = [...new Set(ids)].map((alias) => ({
						alias,
						advisoryId: canonicalId,
					}));
					for (const aliasRow of aliasRows) {
						tx.insert(schema.advisoryAliases)
							.values(aliasRow)
							.onConflictDoNothing()
							.run();
						aliasIndex.set(aliasRow.alias, canonicalId);
					}

					for (const range of advisory.ranges) {
						tx.insert(schema.advisoryRanges)
							.values({
								advisoryId: canonicalId,
								ecosystem: range.ecosystem,
								packageName: range.packageName,
								vulnerableRange: range.vulnerableRange,
								firstPatched: range.firstPatched ?? null,
							})
							.onConflictDoUpdate({
								target: [
									schema.advisoryRanges.advisoryId,
									schema.advisoryRanges.ecosystem,
									schema.advisoryRanges.packageName,
									schema.advisoryRanges.vulnerableRange,
								],
								set: {
									firstPatched: sql`coalesce(excluded.first_patched, "advisory_ranges"."first_patched")`,
								},
							})
							.run();
					}

					for (const source of advisory.sources) {
						tx.insert(schema.advisorySources)
							.values({
								advisoryId: canonicalId,
								source: source.source,
								sourceId: source.sourceId,
								sourceModifiedAt: toDate(
									source.sourceModifiedAt
								),
								fetchedAt: now,
							})
							.onConflictDoUpdate({
								target: [
									schema.advisorySources.advisoryId,
									schema.advisorySources.source,
								],
								set: {
									sourceId: source.sourceId,
									sourceModifiedAt: toDate(
										source.sourceModifiedAt
									),
									fetchedAt: now,
								},
							})
							.run();
					}
				}
			});

			return { inserted, updated };
		},

		/**
		 * `sourceId -> sourceModifiedAt` for already-known records, so the OSV
		 * pass can skip detail fetches whose `modified` has not advanced.
		 */
		async getSourceModified(
			sourceIds: readonly string[]
		): Promise<Map<string, Date | null>> {
			const out = new Map<string, Date | null>();
			for (const chunk of chunked([...new Set(sourceIds)], IN_CHUNK)) {
				if (chunk.length === 0) continue;
				const rows = await db
					.select({
						sourceId: schema.advisorySources.sourceId,
						sourceModifiedAt:
							schema.advisorySources.sourceModifiedAt,
					})
					.from(schema.advisorySources)
					.where(inArray(schema.advisorySources.sourceId, chunk));
				for (const row of rows) {
					out.set(row.sourceId, row.sourceModifiedAt);
				}
			}
			return out;
		},

		/**
		 * Every vulnerable range touching the given packages, with severity.
		 * Scoped to one ecosystem — `requests` on PyPI and `requests` on npm
		 * are unrelated packages that must never see each other's advisories.
		 */
		async rangesForPackages(
			names: readonly string[],
			ecosystem: Ecosystem = 'npm'
		): Promise<Map<string, PackageRangeMatch[]>> {
			const out = new Map<string, PackageRangeMatch[]>();
			for (const chunk of chunked([...new Set(names)], IN_CHUNK)) {
				if (chunk.length === 0) continue;
				const rows = await db
					.select({
						packageName: schema.advisoryRanges.packageName,
						advisoryId: schema.advisoryRanges.advisoryId,
						vulnerableRange: schema.advisoryRanges.vulnerableRange,
						firstPatched: schema.advisoryRanges.firstPatched,
						severity: schema.advisories.severity,
						withdrawnAt: schema.advisories.withdrawnAt,
					})
					.from(schema.advisoryRanges)
					.innerJoin(
						schema.advisories,
						eq(
							schema.advisories.id,
							schema.advisoryRanges.advisoryId
						)
					)
					.where(
						and(
							eq(schema.advisoryRanges.ecosystem, ecosystem),
							inArray(schema.advisoryRanges.packageName, chunk)
						)
					);
				for (const row of rows) {
					if (row.withdrawnAt !== null) continue;
					const list = out.get(row.packageName);
					const match: PackageRangeMatch = {
						advisoryId: row.advisoryId,
						vulnerableRange: row.vulnerableRange,
						firstPatched: row.firstPatched,
						severity: row.severity,
					};
					if (list === undefined) out.set(row.packageName, [match]);
					else list.push(match);
				}
			}
			return out;
		},

		/**
		 * Wholesale-replaces one advisory's ranges. `upsertMerged`'s own range
		 * write is deliberately additive — a scan re-upserts the ranges it saw
		 * this run, but never deletes ones it didn't, because npm and OSV each
		 * contribute independently over time and neither pass sees the other's
		 * data. `advisory.refresh` is different: it just fetched OSV's current,
		 * authoritative record for exactly this advisory, so a range that
		 * narrowed or disappeared upstream must actually disappear here too —
		 * otherwise a finding a corrected advisory no longer covers would stay
		 * open forever, pinned by a stale row `upsertMerged` would never prune.
		 */
		async replaceRangesForAdvisory(
			advisoryId: string,
			ranges: readonly AdvisoryRange[]
		): Promise<void> {
			db.transaction((tx) => {
				tx.delete(schema.advisoryRanges)
					.where(eq(schema.advisoryRanges.advisoryId, advisoryId))
					.run();
				for (const range of ranges) {
					tx.insert(schema.advisoryRanges)
						.values({
							advisoryId,
							ecosystem: range.ecosystem,
							packageName: range.packageName,
							vulnerableRange: range.vulnerableRange,
							firstPatched: range.firstPatched ?? null,
						})
						.run();
				}
			});
		},

		/**
		 * Every advisory carrying an upstream record from `source`, paired with
		 * the id that record is fetched by. `advisory.refresh` uses this against
		 * `source: 'osv'` as its candidate set, then calls `getSourceModified`
		 * with the returned `sourceId`s to decide which need a fresh detail
		 * fetch.
		 */
		async advisoriesWithSource(
			source: AdvisorySourceRow['source']
		): Promise<{ advisoryId: string; sourceId: string }[]> {
			return db
				.select({
					advisoryId: schema.advisorySources.advisoryId,
					sourceId: schema.advisorySources.sourceId,
				})
				.from(schema.advisorySources)
				.where(eq(schema.advisorySources.source, source));
		},

		/**
		 * Advisories due a threat-intel refresh, each with its CVE aliases.
		 *
		 * Keyed on the CVE rather than the advisory id because both feeds are
		 * CVE-indexed: EPSS scores CVEs, and CISA's catalogue lists them. A
		 * GHSA that was never assigned a CVE therefore has nothing to look up,
		 * and is excluded by the join rather than fetched and discarded.
		 */
		async advisoriesNeedingThreatIntel(
			staleBefore: Date,
			limit: number
		): Promise<{ advisoryId: string; cveIds: string[] }[]> {
			const rows = await db
				.select({
					advisoryId: schema.advisories.id,
					alias: schema.advisoryAliases.alias,
				})
				.from(schema.advisories)
				.innerJoin(
					schema.advisoryAliases,
					eq(schema.advisoryAliases.advisoryId, schema.advisories.id)
				)
				.where(
					and(
						like(schema.advisoryAliases.alias, 'CVE-%'),
						or(
							sql`${schema.advisories.threatIntelUpdatedAt} is null`,
							sql`${schema.advisories.threatIntelUpdatedAt} < ${staleBefore.getTime()}`
						)
					)
				)
				.orderBy(schema.advisories.id)
				.limit(limit);

			const byAdvisory = new Map<string, string[]>();
			for (const row of rows) {
				const bucket = byAdvisory.get(row.advisoryId);
				if (bucket === undefined)
					byAdvisory.set(row.advisoryId, [row.alias]);
				else bucket.push(row.alias);
			}
			return [...byAdvisory].map(([advisoryId, cveIds]) => ({
				advisoryId,
				cveIds,
			}));
		},

		/**
		 * Writes the exploitation signals. `threatIntelUpdatedAt` is stamped
		 * even when the feeds had nothing to say about an advisory, so one that
		 * nobody scores is not re-queried on every single run.
		 *
		 * `writeEpss` / `writeKev` exist because the two feeds fail
		 * independently. A `null` from a feed that answered means "this CVE is
		 * genuinely not listed/scored" and must be written; a `null` from a
		 * feed that was unreachable means nothing at all, and writing it would
		 * silently erase a KEV listing because CISA had a bad minute.
		 */
		async applyThreatIntel(
			rows: readonly {
				advisoryId: string;
				epssScore: number | null;
				epssPercentile: number | null;
				kevAddedAt: Date | null;
				kevKnownRansomware: boolean | null;
			}[],
			now: Date,
			options: { writeEpss: boolean; writeKev: boolean }
		): Promise<number> {
			if (rows.length === 0) return 0;
			if (!options.writeEpss && !options.writeKev) return 0;
			db.transaction((tx) => {
				for (const row of rows) {
					tx.update(schema.advisories)
						.set({
							...(options.writeEpss
								? {
										epssScore: row.epssScore,
										epssPercentile: row.epssPercentile,
									}
								: {}),
							...(options.writeKev
								? {
										kevAddedAt: row.kevAddedAt,
										kevKnownRansomware:
											row.kevKnownRansomware,
									}
								: {}),
							threatIntelUpdatedAt: now,
						})
						.where(eq(schema.advisories.id, row.advisoryId))
						.run();
				}
			});
			return rows.length;
		},

		/**
		 * Which of these advisories CISA lists as exploited in the wild.
		 * One query for a whole scan diff, so the auto-PR gate does not issue
		 * a lookup per finding.
		 */
		async kevListedIds(
			advisoryIds: readonly string[]
		): Promise<Set<string>> {
			const out = new Set<string>();
			if (advisoryIds.length === 0) return out;
			const unique = [...new Set(advisoryIds)];
			for (let index = 0; index < unique.length; index += 200) {
				const rows = await db
					.select({ id: schema.advisories.id })
					.from(schema.advisories)
					.where(
						and(
							inArray(
								schema.advisories.id,
								unique.slice(index, index + 200)
							),
							sql`${schema.advisories.kevAddedAt} is not null`
						)
					);
				for (const row of rows) out.add(row.id);
			}
			return out;
		},

		/** Accepts a canonical id or any known alias. */
		async advisoryById(advisoryId: string): Promise<AdvisoryDetail | null> {
			const alias = await db.query.advisoryAliases.findFirst({
				where: eq(schema.advisoryAliases.alias, advisoryId),
			});
			const canonicalId = alias?.advisoryId ?? advisoryId;
			const advisory = await db.query.advisories.findFirst({
				where: eq(schema.advisories.id, canonicalId),
			});
			if (advisory === undefined) return null;

			const [aliases, ranges, sources] = await Promise.all([
				db
					.select({ alias: schema.advisoryAliases.alias })
					.from(schema.advisoryAliases)
					.where(eq(schema.advisoryAliases.advisoryId, canonicalId)),
				db
					.select()
					.from(schema.advisoryRanges)
					.where(eq(schema.advisoryRanges.advisoryId, canonicalId)),
				db
					.select()
					.from(schema.advisorySources)
					.where(eq(schema.advisorySources.advisoryId, canonicalId)),
			]);

			return {
				advisory,
				aliases: aliases
					.map((row) => row.alias)
					.filter((value) => value !== canonicalId)
					.sort(),
				ranges,
				sources,
			};
		},
	};
}

export type AdvisoriesStore = ReturnType<typeof createAdvisoriesStore>;
