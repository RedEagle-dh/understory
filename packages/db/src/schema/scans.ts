import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { projects } from './projects';
import {
	DEP_TYPES,
	PACKAGE_MANAGERS,
	SCAN_STATUSES,
	SCAN_TRIGGERS,
} from './types';

/**
 * One row per scan attempt. Counters are nullable because they're only
 * populated once the scan reaches `status: 'ok'`.
 *
 * Note on `(projectId, startedAt)`: this is an ascending composite index.
 * SQLite serves `ORDER BY startedAt DESC` off an ascending index via a
 * cheap reverse scan, so a separate descending index isn't needed for the
 * "most recent scans" query.
 */
export const scans = sqliteTable(
	'scans',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		trigger: text('trigger', { enum: SCAN_TRIGGERS }).notNull(),
		status: text('status', { enum: SCAN_STATUSES }).notNull(),
		commitSha: text('commit_sha'),
		branch: text('branch'),
		/** No FK: dependency sets are pruned independently of scans; the app checks referential safety first. */
		dependencySetId: text('dependency_set_id'),
		lockHash: text('lock_hash'),
		/** True when this scan reused an existing dependencySet instead of re-parsing the lockfile. */
		depsReused: integer('deps_reused', { mode: 'boolean' })
			.notNull()
			.default(false),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
		durationMs: integer('duration_ms'),
		totalDeps: integer('total_deps'),
		directDeps: integer('direct_deps'),
		peerDeps: integer('peer_deps'),
		vulnCritical: integer('vuln_critical'),
		vulnHigh: integer('vuln_high'),
		vulnModerate: integer('vuln_moderate'),
		vulnLow: integer('vuln_low'),
		outdatedCount: integer('outdated_count'),
		majorOutdatedCount: integer('major_outdated_count'),
		newFindings: integer('new_findings'),
		resolvedFindings: integer('resolved_findings'),
		errorCode: text('error_code'),
		errorMessage: text('error_message'),
		/** No FK yet: references the user table for manual triggers, added in a later phase. */
		triggeredBy: text('triggered_by'),
	},
	(t) => [
		index('scans_project_id_started_at_idx').on(t.projectId, t.startedAt),
		index('scans_status_idx').on(t.status),
	]
);

export type Scan = typeof scans.$inferSelect;
export type NewScan = typeof scans.$inferInsert;

/**
 * Content-addressed dependency snapshot, keyed by lockfile hash. Deliberately
 * NOT one row per scan (a 1500-dep project scanned hourly would be 36k
 * rows/day) — scans just point at the set matching their lockfile hash.
 * Sets are pruned by the retention job once no scan references them.
 */
export const dependencySets = sqliteTable(
	'dependency_sets',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		lockHash: text('lock_hash').notNull(),
		manager: text('manager', { enum: PACKAGE_MANAGERS }).notNull(),
		packageCount: integer('package_count').notNull(),
		directCount: integer('direct_count').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		/** No FK: recorded for provenance only; avoids a scans<->dependencySets reference cycle. */
		firstScanId: text('first_scan_id').notNull(),
	},
	(t) => [
		uniqueIndex('dependency_sets_project_id_lock_hash_unique').on(
			t.projectId,
			t.lockHash
		),
	]
);

export type DependencySet = typeof dependencySets.$inferSelect;
export type NewDependencySet = typeof dependencySets.$inferInsert;

/**
 * One row per (workspace, name, version, depType) in a dependency set.
 * `id` is an autoincrement integer, not an app-generated id — these rows are
 * high-volume and never referenced by other tables, so a surrogate integer
 * key is cheaper than a 22-char text id.
 */
export const dependencySetEntries = sqliteTable(
	'dependency_set_entries',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		setId: text('set_id')
			.notNull()
			.references(() => dependencySets.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		version: text('version').notNull(),
		/** '' = the workspace root. */
		workspace: text('workspace').notNull().default(''),
		depType: text('dep_type', { enum: DEP_TYPES }).notNull(),
		isDirect: integer('is_direct', { mode: 'boolean' }).notNull(),
		depth: integer('depth').notNull(),
		/** Declared semver range; only meaningful for direct dependencies. */
		declaredRange: text('declared_range'),
		/** JSON object of this entry's own peerDependencies, as declared by the package. */
		peerDepsJson: text('peer_deps_json'),
		resolved: text('resolved'),
	},
	(t) => [
		index('dependency_set_entries_set_id_name_idx').on(t.setId, t.name),
		index('dependency_set_entries_set_id_is_direct_idx').on(
			t.setId,
			t.isDirect
		),
		uniqueIndex('dependency_set_entries_unique').on(
			t.setId,
			t.workspace,
			t.name,
			t.version,
			t.depType
		),
	]
);

export type DependencySetEntry = typeof dependencySetEntries.$inferSelect;
export type NewDependencySetEntry = typeof dependencySetEntries.$inferInsert;
