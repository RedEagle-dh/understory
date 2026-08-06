import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Singleton row (id = 1) holding instance-wide configuration. The app
 * upserts/reads exactly this one row. `setupCompletedAt` doubles as a
 * race-free "an admin has claimed this instance" latch for the auth
 * bootstrap flow (auth tables land in a later phase — see schema/index.ts).
 */
export const appSettings = sqliteTable('app_settings', {
	id: integer('id').primaryKey(),
	setupCompletedAt: integer('setup_completed_at', { mode: 'timestamp_ms' }),
	defaultScanIntervalMinutes: integer('default_scan_interval_minutes')
		.notNull()
		.default(60),
	retentionScansPerProject: integer('retention_scans_per_project')
		.notNull()
		.default(200),
	retentionDeliveryDays: integer('retention_delivery_days')
		.notNull()
		.default(90),
	/** AES-256-GCM sealed (src/crypto.ts) fallback GitHub token used when a project has none of its own. */
	githubDefaultTokenEnc: text('github_default_token_enc'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type AppSettings = typeof appSettings.$inferSelect;
export type NewAppSettings = typeof appSettings.$inferInsert;

/**
 * ETag/body cache for npm registry + GitHub responses. `key` is an
 * app-defined namespaced string, e.g. `packument:lodash`, `disttags:lodash`,
 * `gh:tree:owner/repo@sha`.
 */
export const registryCache = sqliteTable(
	'registry_cache',
	{
		key: text('key').primaryKey(),
		etag: text('etag'),
		/** JSON-serialized cached response body; shape depends on the `key` namespace. */
		bodyJson: text('body_json'),
		fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => [index('registry_cache_expires_at_idx').on(t.expiresAt)]
);

export type RegistryCacheEntry = typeof registryCache.$inferSelect;
export type NewRegistryCacheEntry = typeof registryCache.$inferInsert;

/**
 * Product-level audit trail (distinct from any framework access log): "who
 * created this PR", "who changed this token", etc. `actorUserId` is a plain
 * text column (no FK yet) — it will reference the `user` table once auth
 * lands.
 */
export const auditLog = sqliteTable(
	'audit_log',
	{
		id: text('id').primaryKey(),
		actorUserId: text('actor_user_id'),
		action: text('action').notNull(),
		targetType: text('target_type').notNull(),
		targetId: text('target_id'),
		/** JSON-serialized free-form metadata about the action. */
		metaJson: text('meta_json'),
		ip: text('ip'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => [index('audit_log_created_at_idx').on(t.createdAt)]
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
