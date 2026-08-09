import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { BUMP_KINDS, SEVERITIES } from './types';

/**
 * A registered GitHub repository the scanner tracks.
 *
 * `branch` uses the empty string `''` as a sentinel for "track the repo's
 * default branch" instead of NULL. SQLite unique indexes treat NULLs as
 * distinct from one another, so `(owner, repo, NULL)` would not reject a
 * second "default branch" registration of the same repo — the NOT NULL
 * empty-string sentinel keeps `(owner, repo, branch)` a real uniqueness
 * guarantee. The same pattern is used for `notificationRules.projectId`.
 */
export const projects = sqliteTable(
	'projects',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		owner: text('owner').notNull(),
		repo: text('repo').notNull(),
		/** '' = track the repository's default branch (resolved per scan). */
		branch: text('branch').notNull().default(''),
		/** JSON string[] of manifest paths; null = auto-detect via the git tree. */
		manifestPathsJson: text('manifest_paths_json'),
		/** AES-256-GCM sealed (src/crypto.ts); null falls back to appSettings.githubDefaultTokenEnc, then GITHUB_TOKEN. */
		githubTokenEnc: text('github_token_enc'),
		/** Last 4 characters of the token, for display only. */
		githubTokenLast4: text('github_token_last4'),
		scanIntervalMinutes: integer('scan_interval_minutes')
			.notNull()
			.default(60),
		/** Deterministic hash(id) % 3600 — the anti-thundering-herd offset within the scan interval. */
		scanOffsetSeconds: integer('scan_offset_seconds').notNull(),
		/** The scheduler's driving column: WHERE paused = 0 AND next_scan_at <= now. */
		nextScanAt: integer('next_scan_at', { mode: 'timestamp_ms' }).notNull(),
		paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
		/** Drives exponential scheduling backoff after failed scans. */
		consecutiveFailures: integer('consecutive_failures')
			.notNull()
			.default(0),
		/** No FK on either scan pointer: avoids a projects<->scans reference cycle. */
		lastScanId: text('last_scan_id'),
		lastSuccessScanId: text('last_success_scan_id'),
		/** Short-circuits re-parsing the lockfile when the scanner sees the same hash again. */
		lastLockHash: text('last_lock_hash'),
		autoPrEnabled: integer('auto_pr_enabled', { mode: 'boolean' })
			.notNull()
			.default(false),
		autoPrMinSeverity: text('auto_pr_min_severity', { enum: SEVERITIES })
			.notNull()
			.default('high'),
		/** Largest bump kind an auto-PR is allowed to make; refuses breaking auto-PRs beyond this. */
		autoPrMaxBump: text('auto_pr_max_bump', { enum: BUMP_KINDS })
			.notNull()
			.default('minor'),
		/**
		 * When set, a finding whose CVE is in CISA's Known Exploited
		 * Vulnerabilities catalogue opens an auto-PR regardless of
		 * `autoPrMinSeverity`. Confirmed in-the-wild exploitation outranks a
		 * severity label that was assigned before anyone was being attacked.
		 * `autoPrMaxBump` still applies — this never ships a surprise major.
		 */
		autoPrKevOverride: integer('auto_pr_kev_override', { mode: 'boolean' })
			.notNull()
			.default(false),
		/** Open PRs bumping outdated direct deps to latest (not just security fixes). */
		autoBumpEnabled: integer('auto_bump_enabled', { mode: 'boolean' })
			.notNull()
			.default(false),
		/** Largest update kind auto-bump PRs may make (patch ⊂ minor ⊂ major). */
		autoBumpMaxKind: text('auto_bump_max_kind', { enum: BUMP_KINDS })
			.notNull()
			.default('patch'),
		/**
		 * Supply-chain cooldown: a target version qualifies only once it has
		 * been on the registry for at least this many hours (0 = immediately).
		 */
		autoBumpMinReleaseAgeHours: integer('auto_bump_min_release_age_hours')
			.notNull()
			.default(72),
		/** null = use `branch` as the PR base. */
		prBaseBranch: text('pr_base_branch'),
		/** JSON string[] of labels applied to opened PRs. */
		prLabelsJson: text('pr_labels_json'),
		regenerateLockfile: integer('regenerate_lockfile', { mode: 'boolean' })
			.notNull()
			.default(true),
		notifyOnNewMajor: integer('notify_on_new_major', { mode: 'boolean' })
			.notNull()
			.default(false),
		/** No FK yet: references the user table, added in a later phase. */
		createdBy: text('created_by'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => [
		uniqueIndex('projects_owner_repo_branch_unique').on(
			t.owner,
			t.repo,
			t.branch
		),
		index('projects_next_scan_at_idx').on(t.nextScanAt),
		index('projects_paused_next_scan_at_idx').on(t.paused, t.nextScanAt),
	]
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
