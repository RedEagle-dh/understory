import type { Severity } from '@workspace/audit-engine';
import { type Db, id, schema } from '@workspace/db';
import type {
	DeliveryStatus,
	EventType,
	NotificationChannelType,
} from '@workspace/db/schema';
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	lt,
	lte,
	type SQL,
	sql,
} from 'drizzle-orm';

export type NotificationChannelRow =
	typeof schema.notificationChannels.$inferSelect;
export type NotificationRuleRow = typeof schema.notificationRules.$inferSelect;
export type NotificationDeliveryRow =
	typeof schema.notificationDeliveries.$inferSelect;

/**
 * Seals/opens a channel's config at rest. Injected rather than imported so the
 * store stays testable with an in-memory box and so the AAD binding
 * (`channelConfigAad(channelId)`) lives in exactly one place.
 */
export interface ChannelCrypto {
	seal(channelId: string, config: Record<string, unknown>): Promise<string>;
	open(channelId: string, sealed: string): Promise<Record<string, unknown>>;
}

export interface CreateChannelInput {
	name: string;
	type: NotificationChannelType;
	/** Full config INCLUDING secrets — sealed before it touches SQLite. */
	config: Record<string, unknown>;
	/** Non-secret display projection, persisted in the clear. */
	configPublic: Record<string, unknown>;
	enabled?: boolean;
	createdBy?: string;
}

export interface UpdateChannelInput {
	name?: string;
	enabled?: boolean;
	config?: Record<string, unknown>;
	configPublic?: Record<string, unknown>;
}

export interface UpsertRuleInput {
	channelId: string;
	/** '' = all projects. */
	projectId: string;
	eventType: EventType;
	minSeverity?: Severity | null;
	enabled?: boolean;
}

export interface RuleWithChannel {
	rule: NotificationRuleRow;
	channel: NotificationChannelRow;
}

export interface InsertDeliveryInput {
	channelId: string;
	eventKey: string;
	eventType: EventType;
	projectId: string | null;
	payloadJson: string;
}

export interface DeliveryFilters {
	channelId?: string;
	projectId?: string;
	eventType?: EventType;
	status?: DeliveryStatus;
	page: number;
	pageSize: number;
}

export function createNotificationsStore(db: Db, crypto: ChannelCrypto) {
	const channels = {
		async create(
			input: CreateChannelInput
		): Promise<NotificationChannelRow> {
			const channelId = id();
			const now = new Date();
			const [row] = await db
				.insert(schema.notificationChannels)
				.values({
					id: channelId,
					name: input.name,
					type: input.type,
					configEnc: await crypto.seal(channelId, input.config),
					configPublicJson: JSON.stringify(input.configPublic),
					enabled: input.enabled ?? true,
					createdBy: input.createdBy ?? null,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			if (row === undefined) throw new Error('insert returned no row');
			return row;
		},

		async get(channelId: string): Promise<NotificationChannelRow | null> {
			const row = await db.query.notificationChannels.findFirst({
				where: eq(schema.notificationChannels.id, channelId),
			});
			return row ?? null;
		},

		async byName(name: string): Promise<NotificationChannelRow | null> {
			const row = await db.query.notificationChannels.findFirst({
				where: eq(schema.notificationChannels.name, name),
			});
			return row ?? null;
		},

		async list(): Promise<NotificationChannelRow[]> {
			return db
				.select()
				.from(schema.notificationChannels)
				.orderBy(schema.notificationChannels.name);
		},

		/** Unseals the stored config — the ONLY path secrets take back out. */
		async openConfig(
			channel: NotificationChannelRow
		): Promise<Record<string, unknown>> {
			return crypto.open(channel.id, channel.configEnc);
		},

		async update(
			channelId: string,
			patch: UpdateChannelInput
		): Promise<NotificationChannelRow | null> {
			const [row] = await db
				.update(schema.notificationChannels)
				.set({
					...(patch.name === undefined ? {} : { name: patch.name }),
					...(patch.enabled === undefined
						? {}
						: { enabled: patch.enabled }),
					...(patch.config === undefined
						? {}
						: {
								configEnc: await crypto.seal(
									channelId,
									patch.config
								),
							}),
					...(patch.configPublic === undefined
						? {}
						: {
								configPublicJson: JSON.stringify(
									patch.configPublic
								),
							}),
					updatedAt: new Date(),
				})
				.where(eq(schema.notificationChannels.id, channelId))
				.returning();
			return row ?? null;
		},

		async delete(channelId: string): Promise<boolean> {
			const deleted = await db
				.delete(schema.notificationChannels)
				.where(eq(schema.notificationChannels.id, channelId))
				.returning({ id: schema.notificationChannels.id });
			return deleted.length > 0;
		},

		async markSuccess(channelId: string, at: Date): Promise<void> {
			await db
				.update(schema.notificationChannels)
				.set({ lastSuccessAt: at, lastError: null, lastErrorAt: null })
				.where(eq(schema.notificationChannels.id, channelId));
		},

		async markError(
			channelId: string,
			error: string,
			at: Date
		): Promise<void> {
			await db
				.update(schema.notificationChannels)
				.set({ lastError: error.slice(0, 1000), lastErrorAt: at })
				.where(eq(schema.notificationChannels.id, channelId));
		},
	};

	const rules = {
		/** Unique on `(channelId, projectId, eventType)`, so this is an upsert. */
		async upsert(input: UpsertRuleInput): Promise<NotificationRuleRow> {
			const [row] = await db
				.insert(schema.notificationRules)
				.values({
					id: id(),
					channelId: input.channelId,
					projectId: input.projectId,
					eventType: input.eventType,
					minSeverity: input.minSeverity ?? null,
					enabled: input.enabled ?? true,
				})
				.onConflictDoUpdate({
					target: [
						schema.notificationRules.channelId,
						schema.notificationRules.projectId,
						schema.notificationRules.eventType,
					],
					set: {
						minSeverity: sql`excluded.min_severity`,
						enabled: sql`excluded.enabled`,
					},
				})
				.returning();
			if (row === undefined) throw new Error('upsert returned no row');
			return row;
		},

		async list(filters: {
			channelId?: string;
			projectId?: string;
			eventType?: EventType;
		}): Promise<NotificationRuleRow[]> {
			const clauses: (SQL | undefined)[] = [];
			if (filters.channelId !== undefined) {
				clauses.push(
					eq(schema.notificationRules.channelId, filters.channelId)
				);
			}
			if (filters.projectId !== undefined) {
				clauses.push(
					eq(schema.notificationRules.projectId, filters.projectId)
				);
			}
			if (filters.eventType !== undefined) {
				clauses.push(
					eq(schema.notificationRules.eventType, filters.eventType)
				);
			}
			return db
				.select()
				.from(schema.notificationRules)
				.where(clauses.length === 0 ? undefined : and(...clauses));
		},

		/**
		 * Resolution query: enabled rules on enabled channels matching the
		 * event, scoped either globally (`projectId = ''`) or to this project.
		 */
		async matching(
			eventType: EventType,
			projectId: string
		): Promise<RuleWithChannel[]> {
			return db
				.select({
					rule: schema.notificationRules,
					channel: schema.notificationChannels,
				})
				.from(schema.notificationRules)
				.innerJoin(
					schema.notificationChannels,
					eq(
						schema.notificationChannels.id,
						schema.notificationRules.channelId
					)
				)
				.where(
					and(
						eq(schema.notificationRules.eventType, eventType),
						eq(schema.notificationRules.enabled, true),
						eq(schema.notificationChannels.enabled, true),
						inArray(schema.notificationRules.projectId, [
							'',
							projectId,
						])
					)
				);
		},

		/** Every enabled rule for an event type, regardless of project scope. */
		async enabledForEvent(
			eventType: EventType
		): Promise<RuleWithChannel[]> {
			return db
				.select({
					rule: schema.notificationRules,
					channel: schema.notificationChannels,
				})
				.from(schema.notificationRules)
				.innerJoin(
					schema.notificationChannels,
					eq(
						schema.notificationChannels.id,
						schema.notificationRules.channelId
					)
				)
				.where(
					and(
						eq(schema.notificationRules.eventType, eventType),
						eq(schema.notificationRules.enabled, true),
						eq(schema.notificationChannels.enabled, true)
					)
				);
		},

		async delete(ruleId: string): Promise<boolean> {
			const deleted = await db
				.delete(schema.notificationRules)
				.where(eq(schema.notificationRules.id, ruleId))
				.returning({ id: schema.notificationRules.id });
			return deleted.length > 0;
		},
	};

	const deliveries = {
		/**
		 * THE dedupe mechanic. `(channelId, eventKey)` is unique, so a losing
		 * insert means some earlier dispatch already owns this event — the
		 * caller skips silently. Returns the row only when this call won.
		 */
		async tryInsert(
			input: InsertDeliveryInput
		): Promise<NotificationDeliveryRow | null> {
			const [row] = await db
				.insert(schema.notificationDeliveries)
				.values({
					id: id(),
					channelId: input.channelId,
					projectId: input.projectId,
					eventType: input.eventType,
					eventKey: input.eventKey,
					status: 'pending',
					attempts: 0,
					payloadJson: input.payloadJson,
					createdAt: new Date(),
				})
				.onConflictDoNothing({
					target: [
						schema.notificationDeliveries.channelId,
						schema.notificationDeliveries.eventKey,
					],
				})
				.returning();
			return row ?? null;
		},

		async byId(
			deliveryId: string
		): Promise<NotificationDeliveryRow | null> {
			const row = await db.query.notificationDeliveries.findFirst({
				where: eq(schema.notificationDeliveries.id, deliveryId),
			});
			return row ?? null;
		},

		async markSent(deliveryId: string, at: Date): Promise<void> {
			await db
				.update(schema.notificationDeliveries)
				.set({
					status: 'sent',
					sentAt: at,
					error: null,
					nextAttemptAt: null,
					attempts: sql`${schema.notificationDeliveries.attempts} + 1`,
				})
				.where(eq(schema.notificationDeliveries.id, deliveryId));
		},

		/**
		 * `nextAttemptAt = null` is how a delivery says "do not come back":
		 * the retry query requires a non-null, past due time, so permanent
		 * failures and exhausted retries drop out of it without a second flag.
		 */
		async markFailed(
			deliveryId: string,
			input: {
				attempts: number;
				nextAttemptAt: Date | null;
				error: string;
			}
		): Promise<void> {
			await db
				.update(schema.notificationDeliveries)
				.set({
					status: 'failed',
					attempts: input.attempts,
					nextAttemptAt: input.nextAttemptAt,
					error: input.error.slice(0, 1000),
				})
				.where(eq(schema.notificationDeliveries.id, deliveryId));
		},

		async markSkipped(deliveryId: string, reason: string): Promise<void> {
			await db
				.update(schema.notificationDeliveries)
				.set({
					status: 'skipped',
					nextAttemptAt: null,
					error: reason.slice(0, 1000),
				})
				.where(eq(schema.notificationDeliveries.id, deliveryId));
		},

		async listPendingRetries(
			now: Date,
			maxAttempts: number,
			limit: number
		): Promise<NotificationDeliveryRow[]> {
			return db
				.select()
				.from(schema.notificationDeliveries)
				.where(
					and(
						eq(schema.notificationDeliveries.status, 'failed'),
						lt(schema.notificationDeliveries.attempts, maxAttempts),
						isNotNull(schema.notificationDeliveries.nextAttemptAt),
						lte(schema.notificationDeliveries.nextAttemptAt, now)
					)
				)
				.orderBy(schema.notificationDeliveries.nextAttemptAt)
				.limit(limit);
		},

		async list(
			filters: DeliveryFilters
		): Promise<{ items: NotificationDeliveryRow[]; total: number }> {
			const clauses: (SQL | undefined)[] = [];
			if (filters.channelId !== undefined) {
				clauses.push(
					eq(
						schema.notificationDeliveries.channelId,
						filters.channelId
					)
				);
			}
			if (filters.projectId !== undefined) {
				clauses.push(
					eq(
						schema.notificationDeliveries.projectId,
						filters.projectId
					)
				);
			}
			if (filters.eventType !== undefined) {
				clauses.push(
					eq(
						schema.notificationDeliveries.eventType,
						filters.eventType
					)
				);
			}
			if (filters.status !== undefined) {
				clauses.push(
					eq(schema.notificationDeliveries.status, filters.status)
				);
			}
			const where = clauses.length === 0 ? undefined : and(...clauses);
			const [items, [total]] = await Promise.all([
				db
					.select()
					.from(schema.notificationDeliveries)
					.where(where)
					.orderBy(desc(schema.notificationDeliveries.createdAt))
					.limit(filters.pageSize)
					.offset((filters.page - 1) * filters.pageSize),
				db
					.select({ count: sql<number>`count(*)` })
					.from(schema.notificationDeliveries)
					.where(where),
			]);
			return { items, total: total?.count ?? 0 };
		},

		/** Retention: settled deliveries older than the cutoff. Pending rows stay. */
		async pruneOlderThan(cutoff: Date): Promise<number> {
			const deleted = await db
				.delete(schema.notificationDeliveries)
				.where(
					and(
						lt(schema.notificationDeliveries.createdAt, cutoff),
						sql`${schema.notificationDeliveries.status} <> 'pending'`
					)
				)
				.returning({ id: schema.notificationDeliveries.id });
			return deleted.length;
		},
	};

	return { channels, rules, deliveries };
}

export type NotificationsStore = ReturnType<typeof createNotificationsStore>;
