import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { advisories } from './advisories';
import { findings } from './findings';
import { projects } from './projects';
import { PULL_REQUEST_KINDS, PULL_REQUEST_STATES } from './types';

/**
 * A GitHub PR the system opened (or is opening) to bump one or more
 * dependencies. `(projectId, branch)` is the idempotency guard — branch
 * names are deterministic (derived from the bump plan), so a second attempt
 * at the same bump naturally collides here instead of opening a duplicate.
 */
export const pullRequests = sqliteTable(
	'pull_requests',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		number: integer('number'),
		url: text('url'),
		branch: text('branch').notNull(),
		baseBranch: text('base_branch').notNull(),
		kind: text('kind', { enum: PULL_REQUEST_KINDS }).notNull(),
		state: text('state', { enum: PULL_REQUEST_STATES }).notNull(),
		title: text('title').notNull(),
		commitSha: text('commit_sha'),
		lockfileUpdated: integer('lockfile_updated', { mode: 'boolean' })
			.notNull()
			.default(false),
		/** No FK yet: references the user table, added in a later phase. */
		createdByUserId: text('created_by_user_id'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
		mergedAt: integer('merged_at', { mode: 'timestamp_ms' }),
		closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
		lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
		errorMessage: text('error_message'),
	},
	(t) => [
		uniqueIndex('pull_requests_project_id_branch_unique').on(
			t.projectId,
			t.branch
		),
		index('pull_requests_project_id_state_idx').on(t.projectId, t.state),
	]
);

export type PullRequest = typeof pullRequests.$inferSelect;
export type NewPullRequest = typeof pullRequests.$inferInsert;

/** One row per package version bump included in a pull request. */
export const pullRequestBumps = sqliteTable(
	'pull_request_bumps',
	{
		id: text('id').primaryKey(),
		pullRequestId: text('pull_request_id')
			.notNull()
			.references(() => pullRequests.id, { onDelete: 'cascade' }),
		packageName: text('package_name').notNull(),
		/** '' = the workspace root. */
		workspace: text('workspace').notNull().default(''),
		fromRange: text('from_range'),
		fromVersion: text('from_version'),
		toVersion: text('to_version').notNull(),
		/** Set when the bump was driven by a security fix; null for a plain outdated-version bump. */
		advisoryId: text('advisory_id').references(() => advisories.id, {
			onDelete: 'set null',
		}),
		findingId: text('finding_id').references(() => findings.id, {
			onDelete: 'set null',
		}),
	},
	(t) => [
		index('pull_request_bumps_pull_request_id_idx').on(t.pullRequestId),
		index('pull_request_bumps_package_name_idx').on(t.packageName),
	]
);

export type PullRequestBump = typeof pullRequestBumps.$inferSelect;
export type NewPullRequestBump = typeof pullRequestBumps.$inferInsert;
