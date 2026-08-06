import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
	DELIVERY_STATUSES,
	EVENT_TYPES,
	NOTIFICATION_CHANNEL_TYPES,
} from './types';

/**
 * A configured outbound channel (Resend-backed email, or a Discord
 * webhook). `configEnc` holds the AES-256-GCM sealed (src/crypto.ts) JSON
 * config (API key / webhook URL, etc.); `configPublicJson` holds only the
 * non-secret display fields (e.g. from-address, webhook host + id prefix)
 * so the UI can show "which channel is this" without ever handling the
 * secret.
 */
export const notificationChannels = sqliteTable('notification_channels', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	type: text('type', { enum: NOTIFICATION_CHANNEL_TYPES }).notNull(),
	configEnc: text('config_enc').notNull(),
	/** JSON: non-secret display fields only — never the API key / webhook token. */
	configPublicJson: text('config_public_json').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	/** No FK yet: references the user table, added in a later phase. */
	createdBy: text('created_by'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
	lastError: text('last_error'),
	lastErrorAt: integer('last_error_at', { mode: 'timestamp_ms' }),
});

export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NewNotificationChannel = typeof notificationChannels.$inferInsert;

/**
 * Which events a channel should fire for, optionally scoped to one project.
 * `projectId` uses the empty string `''` as a sentinel for "all projects"
 * instead of NULL, for the same reason `projects.branch` does (see
 * schema/projects.ts) — SQLite's unique indexes treat NULLs as distinct, so
 * NULL couldn't enforce "only one all-projects rule per (channel, event)".
 * Consequently there is no FK on this column; the sentinel value would
 * violate a `references(() => projects.id)` constraint.
 */
export const notificationRules = sqliteTable(
	'notification_rules',
	{
		id: text('id').primaryKey(),
		channelId: text('channel_id')
			.notNull()
			.references(() => notificationChannels.id, { onDelete: 'cascade' }),
		/** '' = all projects. */
		projectId: text('project_id').notNull().default(''),
		eventType: text('event_type', { enum: EVENT_TYPES }).notNull(),
		minSeverity: text('min_severity'),
		enabled: integer('enabled', { mode: 'boolean' })
			.notNull()
			.default(true),
	},
	(t) => [
		uniqueIndex('notification_rules_unique').on(
			t.channelId,
			t.projectId,
			t.eventType
		),
	]
);

export type NotificationRule = typeof notificationRules.$inferSelect;
export type NewNotificationRule = typeof notificationRules.$inferInsert;

/**
 * Dedupe log + retry queue for outbound notifications. `(channelId,
 * eventKey)` is the dedupe mechanic: `eventKey` is an app-computed string
 * (e.g. `finding:{findingId}` or `scan:{scanId}:digest`) such that a second
 * `dispatch` call for the same logical event is a harmless no-op insert
 * conflict rather than a duplicate send.
 */
export const notificationDeliveries = sqliteTable(
	'notification_deliveries',
	{
		id: text('id').primaryKey(),
		channelId: text('channel_id')
			.notNull()
			.references(() => notificationChannels.id, { onDelete: 'cascade' }),
		/** No FK: intentionally survives project deletion for historical delivery records. */
		projectId: text('project_id'),
		eventType: text('event_type', { enum: EVENT_TYPES }).notNull(),
		eventKey: text('event_key').notNull(),
		status: text('status', { enum: DELIVERY_STATUSES })
			.notNull()
			.default('pending'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }),
		sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
		error: text('error'),
		/** JSON: the rendered payload that was (or will be) sent, kept for the deliveries UI. */
		payloadJson: text('payload_json'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => [
		uniqueIndex('notification_deliveries_channel_id_event_key_unique').on(
			t.channelId,
			t.eventKey
		),
		index('notification_deliveries_status_next_attempt_at_idx').on(
			t.status,
			t.nextAttemptAt
		),
	]
);

export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery =
	typeof notificationDeliveries.$inferInsert;
