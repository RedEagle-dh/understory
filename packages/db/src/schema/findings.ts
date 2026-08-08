import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { advisories } from './advisories';
import { projects } from './projects';
import {
	DEP_TYPES,
	FINDING_STATES,
	FIX_TYPES,
	PEER_ISSUE_KINDS,
	PEER_ISSUE_STATES,
	SEVERITIES,
	UPDATE_KINDS,
} from './types';

/**
 * The diff engine. Makes "what's new since the last scan" a single indexed
 * query instead of a snapshot comparison:
 *   new since scan N   -> WHERE firstSeenScanId = N AND state = 'open'
 *   resolved in scan N -> WHERE resolvedScanId = N
 *   current open set   -> WHERE projectId = ? AND state = 'open'
 *
 * `firstSeenScanId` / `lastSeenScanId` / `resolvedScanId` are plain text
 * pointers with no FK: the retention job prunes old `scans` rows on a
 * schedule independent of finding history, so a hard FK here would block
 * that pruning.
 */
export const findings = sqliteTable(
	'findings',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		advisoryId: text('advisory_id')
			.notNull()
			.references(() => advisories.id),
		packageName: text('package_name').notNull(),
		packageVersion: text('package_version').notNull(),
		/** '' = the workspace root. */
		workspace: text('workspace').notNull().default(''),
		/** Denormalized from advisories.severity at write time (advisory severity can be re-evaluated later). */
		severity: text('severity', { enum: SEVERITIES }).notNull(),
		isDirect: integer('is_direct', { mode: 'boolean' }).notNull(),
		depType: text('dep_type', { enum: DEP_TYPES }).notNull(),
		state: text('state', { enum: FINDING_STATES }).notNull(),
		fixedIn: text('fixed_in'),
		fixType: text('fix_type', { enum: FIX_TYPES }),
		/** True if bumping within the currently declared range resolves the finding (no manifest edit needed). */
		fixWithinRange: integer('fix_within_range', { mode: 'boolean' }),
		firstSeenScanId: text('first_seen_scan_id').notNull(),
		firstSeenAt: integer('first_seen_at', {
			mode: 'timestamp_ms',
		}).notNull(),
		lastSeenScanId: text('last_seen_scan_id').notNull(),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
		resolvedScanId: text('resolved_scan_id'),
		resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
		notifiedAt: integer('notified_at', { mode: 'timestamp_ms' }),
		/** No FK yet: references the user table, added in a later phase. */
		ignoredBy: text('ignored_by'),
		ignoredAt: integer('ignored_at', { mode: 'timestamp_ms' }),
		ignoreReason: text('ignore_reason'),
		ignoreUntil: integer('ignore_until', { mode: 'timestamp_ms' }),
	},
	(t) => [
		uniqueIndex('findings_unique').on(
			t.projectId,
			t.advisoryId,
			t.packageName,
			t.packageVersion
		),
		index('findings_project_id_state_severity_idx').on(
			t.projectId,
			t.state,
			t.severity
		),
		index('findings_first_seen_scan_id_idx').on(t.firstSeenScanId),
		index('findings_resolved_scan_id_idx').on(t.resolvedScanId),
		/**
		 * The two cross-project views. Every per-project index above leads with
		 * `projectId`, which is exactly the column the global inbox and the
		 * package index do NOT filter on — without these, "every open critical"
		 * and "which projects ship lodash" both degrade to a full scan of the
		 * findings table.
		 */
		index('findings_state_severity_idx').on(t.state, t.severity),
		index('findings_state_package_name_idx').on(t.state, t.packageName),
	]
);

export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;

/**
 * Current outdated-version state, one row per (project, workspace,
 * package). Overwritten in place each scan rather than accumulating
 * history — `previousLatestVersion` + `latestChangedAt` capture just enough
 * of the prior state to detect "latest just became a new major".
 */
export const dependencyStatus = sqliteTable(
	'dependency_status',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		/** '' = the workspace root. */
		workspace: text('workspace').notNull().default(''),
		packageName: text('package_name').notNull(),
		currentVersion: text('current_version').notNull(),
		declaredRange: text('declared_range'),
		wantedVersion: text('wanted_version'),
		latestVersion: text('latest_version'),
		isDirect: integer('is_direct', { mode: 'boolean' }).notNull(),
		depType: text('dep_type', { enum: DEP_TYPES }).notNull(),
		updateKind: text('update_kind', { enum: UPDATE_KINDS })
			.notNull()
			.default('none'),
		deprecatedMessage: text('deprecated_message'),
		previousLatestVersion: text('previous_latest_version'),
		latestChangedAt: integer('latest_changed_at', { mode: 'timestamp_ms' }),
		lastCheckedAt: integer('last_checked_at', {
			mode: 'timestamp_ms',
		}).notNull(),
		/** No FK: see findings' scan-pointer note above. */
		lastSeenScanId: text('last_seen_scan_id').notNull(),
	},
	(t) => [
		uniqueIndex('dependency_status_unique').on(
			t.projectId,
			t.workspace,
			t.packageName
		),
		index('dependency_status_project_id_update_kind_idx').on(
			t.projectId,
			t.updateKind
		),
	]
);

export type DependencyStatus = typeof dependencyStatus.$inferSelect;
export type NewDependencyStatus = typeof dependencyStatus.$inferInsert;

/** Missing/invalid peer dependency requirements detected in the tree. */
export const peerIssues = sqliteTable(
	'peer_issues',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		/** The required peer package name. */
		packageName: text('package_name').notNull(),
		requiredBy: text('required_by').notNull(),
		requiredByVersion: text('required_by_version').notNull(),
		requiredRange: text('required_range').notNull(),
		resolvedVersion: text('resolved_version'),
		kind: text('kind', { enum: PEER_ISSUE_KINDS }).notNull(),
		optional: integer('optional', { mode: 'boolean' })
			.notNull()
			.default(false),
		state: text('state', { enum: PEER_ISSUE_STATES })
			.notNull()
			.default('open'),
		/** No FK: see findings' scan-pointer note above. */
		firstSeenScanId: text('first_seen_scan_id').notNull(),
		lastSeenScanId: text('last_seen_scan_id').notNull(),
	},
	(t) => [
		uniqueIndex('peer_issues_unique').on(
			t.projectId,
			t.requiredBy,
			t.requiredByVersion,
			t.packageName
		),
	]
);

export type PeerIssue = typeof peerIssues.$inferSelect;
export type NewPeerIssue = typeof peerIssues.$inferInsert;
