import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { ADVISORY_SOURCES, SEVERITIES } from './types';

/**
 * Canonical, cross-project, cross-source advisory record. `id` is the
 * canonical identifier chosen by the merge step: GHSA if one exists,
 * otherwise CVE, otherwise the raw OSV id.
 */
export const advisories = sqliteTable('advisories', {
	id: text('id').primaryKey(),
	summary: text('summary').notNull(),
	details: text('details'),
	severity: text('severity', { enum: SEVERITIES }).notNull(),
	cvssScore: real('cvss_score'),
	cvssVector: text('cvss_vector'),
	/** JSON string[] of CWE ids. */
	cweIdsJson: text('cwe_ids_json'),
	url: text('url'),
	publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
	modifiedAt: integer('modified_at', { mode: 'timestamp_ms' }),
	withdrawnAt: integer('withdrawn_at', { mode: 'timestamp_ms' }),
	/** JSON: the raw upstream record(s) this advisory was normalized from, kept for debugging/re-normalization. */
	rawJson: text('raw_json'),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type Advisory = typeof advisories.$inferSelect;
export type NewAdvisory = typeof advisories.$inferInsert;

/**
 * Every alternate id an advisory is known by: CVE ids, the npm numeric id
 * (stored as `npm:1106913`), and any GHSA that OSV lists in `aliases`. This
 * is how the merge step maps "npm says GHSA-r5fr-…, OSV says CVE-2021-23337"
 * onto a single `advisories` row.
 */
export const advisoryAliases = sqliteTable(
	'advisory_aliases',
	{
		alias: text('alias').primaryKey(),
		advisoryId: text('advisory_id')
			.notNull()
			.references(() => advisories.id, { onDelete: 'cascade' }),
	},
	(t) => [index('advisory_aliases_advisory_id_idx').on(t.advisoryId)]
);

export type AdvisoryAlias = typeof advisoryAliases.$inferSelect;
export type NewAdvisoryAlias = typeof advisoryAliases.$inferInsert;

/** Per-package vulnerable version range for an advisory. */
export const advisoryRanges = sqliteTable(
	'advisory_ranges',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		advisoryId: text('advisory_id')
			.notNull()
			.references(() => advisories.id, { onDelete: 'cascade' }),
		ecosystem: text('ecosystem').notNull().default('npm'),
		packageName: text('package_name').notNull(),
		vulnerableRange: text('vulnerable_range').notNull(),
		firstPatched: text('first_patched'),
	},
	(t) => [
		index('advisory_ranges_package_name_idx').on(t.packageName),
		uniqueIndex('advisory_ranges_unique').on(
			t.advisoryId,
			t.packageName,
			t.vulnerableRange
		),
	]
);

export type AdvisoryRange = typeof advisoryRanges.$inferSelect;
export type NewAdvisoryRange = typeof advisoryRanges.$inferInsert;

/**
 * Tracks which upstream sources contributed to an advisory and when each was
 * last fetched, so `advisory.refresh` can skip an OSV detail fetch whose
 * `modified` timestamp hasn't advanced.
 */
export const advisorySources = sqliteTable(
	'advisory_sources',
	{
		advisoryId: text('advisory_id')
			.notNull()
			.references(() => advisories.id, { onDelete: 'cascade' }),
		source: text('source', { enum: ADVISORY_SOURCES }).notNull(),
		sourceId: text('source_id').notNull(),
		sourceModifiedAt: integer('source_modified_at', {
			mode: 'timestamp_ms',
		}),
		fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.advisoryId, t.source] })]
);

export type AdvisorySourceRow = typeof advisorySources.$inferSelect;
export type NewAdvisorySourceRow = typeof advisorySources.$inferInsert;
