import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { NotificationProviderType } from '../adapters/notifications/port';
import {
	parseProviderConfig,
	providerFor,
	redactConfig,
} from '../adapters/notifications/registry';
import type { AppEnv } from '../environment';
import { ConflictError, InvalidInputError, NotFoundError } from '../errors';
import { Severity } from '../schemas/common';
import {
	ChannelView,
	DeliveryResultView,
	DeliveryStatus,
	DeliveryView,
	EventType,
	NotificationChannelType,
	RuleView,
} from '../schemas/notification';
import type {
	NotificationChannelRow,
	NotificationRuleRow,
} from '../stores/notifications';

const ChannelIdParam = t.Object({
	channelId: t.String({ minLength: 1, maxLength: 64 }),
});

/** Free-form on the wire, then validated against the provider's own schema. */
const ConfigInput = t.Record(t.String(), t.Unknown());

function parsePublicView(row: NotificationChannelRow): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(row.configPublicJson);
		return typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function toChannelView(row: NotificationChannelRow) {
	return {
		id: row.id,
		name: row.name,
		type: row.type,
		enabled: row.enabled,
		configPublic: parsePublicView(row),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		lastSuccessAt: row.lastSuccessAt,
		lastError: row.lastError,
		lastErrorAt: row.lastErrorAt,
	};
}

const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
type SeverityValue = (typeof SEVERITIES)[number];

/**
 * `notification_rules.min_severity` is an unconstrained TEXT column (the
 * schema is shared and deliberately loose there), so the boundary narrows it
 * rather than trusting the row.
 */
function toRuleView(row: NotificationRuleRow) {
	const minSeverity = SEVERITIES.includes(row.minSeverity as SeverityValue)
		? (row.minSeverity as SeverityValue)
		: null;
	return {
		id: row.id,
		channelId: row.channelId,
		projectId: row.projectId,
		eventType: row.eventType,
		minSeverity,
		enabled: row.enabled,
	};
}

function titleOf(payloadJson: string | null): string | null {
	if (payloadJson === null) return null;
	try {
		const parsed = JSON.parse(payloadJson) as { title?: unknown };
		return typeof parsed.title === 'string' ? parsed.title : null;
	} catch {
		return null;
	}
}

export function notificationsModule() {
	return defineModule({
		id: 'notifications',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			const channelsList = route({
				id: 'notifications.channels.list',
				method: 'GET',
				path: '/api/notification-channels',
				policy: { permissions: { notification: ['read'] } },
				rateLimit: 'read',
				params: t.Object({}),
				query: t.Object({
					page: t.Optional(t.Number({ minimum: 1, default: 1 })),
					pageSize: t.Optional(
						t.Number({ minimum: 1, maximum: 200, default: 50 })
					),
				}),
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(ChannelView, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				docs: {
					summary: 'Configured notification channels (never secrets)',
					tag: 'Notifications',
				},
				handler: async (ctx) => {
					const page = ctx.query.page ?? 1;
					const pageSize = ctx.query.pageSize ?? 50;
					const all = await env.notifications.channels.list();
					return {
						items: all
							.slice((page - 1) * pageSize, page * pageSize)
							.map(toChannelView),
						total: all.length,
						page,
						pageSize,
					};
				},
			});

			const channelsCreate = route({
				id: 'notifications.channels.create',
				method: 'POST',
				path: '/api/notification-channels',
				policy: { permissions: { notification: ['manage'] } },
				rateLimit: 'write',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Object({
					name: t.String({ minLength: 1, maxLength: 100 }),
					type: NotificationChannelType,
					config: ConfigInput,
					enabled: t.Optional(t.Boolean()),
				}),
				response: ChannelView,
				errors: [InvalidInputError, ConflictError],
				docs: {
					summary: 'Create a channel (config is sealed at rest)',
					tag: 'Notifications',
				},
				handler: async (ctx) => {
					const type = ctx.body.type as NotificationProviderType;
					const config = parseProviderConfig(type, ctx.body.config);
					const existing = await env.notifications.channels.byName(
						ctx.body.name
					);
					if (existing !== null) {
						throw new ConflictError(
							`A notification channel named ${ctx.body.name} already exists`
						);
					}

					const row = await env.notifications.channels.create({
						name: ctx.body.name,
						type,
						config,
						configPublic: providerFor(type).publicView(config),
						enabled: ctx.body.enabled,
						createdBy: ctx.user.id,
					});
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'notificationChannel.create',
						targetType: 'notificationChannel',
						targetId: row.id,
						meta: { type, config: redactConfig(type, config) },
					});
					return toChannelView(row);
				},
			});

			const channelsUpdate = route({
				id: 'notifications.channels.update',
				method: 'PATCH',
				path: '/api/notification-channels/:channelId',
				policy: { permissions: { notification: ['manage'] } },
				rateLimit: 'write',
				params: ChannelIdParam,
				query: t.Object({}),
				body: t.Object({
					name: t.Optional(
						t.String({ minLength: 1, maxLength: 100 })
					),
					enabled: t.Optional(t.Boolean()),
					config: t.Optional(ConfigInput),
				}),
				response: ChannelView,
				errors: [NotFoundError, InvalidInputError],
				docs: {
					summary: 'Update a channel (omitted secrets are kept)',
					tag: 'Notifications',
				},
				handler: async (ctx) => {
					const channel = await env.notifications.channels.get(
						ctx.params.channelId
					);
					if (channel === null) {
						throw new NotFoundError(
							'NotificationChannel',
							ctx.params.channelId
						);
					}

					let config: Record<string, unknown> | undefined;
					let configPublic: Record<string, unknown> | undefined;
					if (ctx.body.config !== undefined) {
						const type = channel.type as NotificationProviderType;
						const stored =
							await env.notifications.channels.openConfig(
								channel
							);
						// A UI that never receives secrets cannot echo them
						// back, so an ABSENT secret field means "unchanged" —
						// only an explicitly supplied one replaces the stored
						// value.
						const merged: Record<string, unknown> = {
							...ctx.body.config,
						};
						for (const field of providerFor(type).secretFields) {
							if (merged[field] === undefined) {
								const previous = stored[field];
								if (previous !== undefined) {
									merged[field] = previous;
								}
							}
						}
						config = parseProviderConfig(type, merged);
						configPublic = providerFor(type).publicView(config);
					}

					const updated = await env.notifications.channels.update(
						channel.id,
						{
							name: ctx.body.name,
							enabled: ctx.body.enabled,
							config,
							configPublic,
						}
					);
					if (updated === null) {
						throw new NotFoundError(
							'NotificationChannel',
							ctx.params.channelId
						);
					}
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'notificationChannel.update',
						targetType: 'notificationChannel',
						targetId: channel.id,
						meta: {
							name: ctx.body.name,
							enabled: ctx.body.enabled,
							configChanged: config !== undefined,
						},
					});
					return toChannelView(updated);
				},
			});

			const channelsDelete = route({
				id: 'notifications.channels.delete',
				method: 'DELETE',
				path: '/api/notification-channels/:channelId',
				policy: { permissions: { notification: ['manage'] } },
				rateLimit: 'write',
				params: ChannelIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({ deleted: t.Boolean() }),
				errors: [NotFoundError],
				docs: {
					summary: 'Delete a channel (rules cascade)',
					tag: 'Notifications',
				},
				handler: async (ctx) => {
					const deleted = await env.notifications.channels.delete(
						ctx.params.channelId
					);
					if (!deleted) {
						throw new NotFoundError(
							'NotificationChannel',
							ctx.params.channelId
						);
					}
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'notificationChannel.delete',
						targetType: 'notificationChannel',
						targetId: ctx.params.channelId,
					});
					return { deleted };
				},
			});

			const channelsTest = route({
				id: 'notifications.channels.test',
				method: 'POST',
				path: '/api/notification-channels/:channelId/test',
				policy: { permissions: { notification: ['manage'] } },
				rateLimit: 'costly',
				params: ChannelIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: DeliveryResultView,
				errors: [NotFoundError],
				docs: {
					summary: 'Send a test notification through the channel',
					tag: 'Notifications',
				},
				handler: async (ctx) => {
					const channel = await env.notifications.channels.get(
						ctx.params.channelId
					);
					if (channel === null) {
						throw new NotFoundError(
							'NotificationChannel',
							ctx.params.channelId
						);
					}
					const provider = providerFor(
						channel.type as NotificationProviderType
					);

					// A test the user can't SEE proves nothing — always deliver
					// a real message. `verify` runs first only as a fast
					// credential precheck so obvious misconfigurations return
					// a precise error instead of a generic send failure.
					let result =
						provider.verify === undefined
							? undefined
							: await provider.verify(
									await env.notifications.channels.openConfig(
										channel
									)
								);
					if (result === undefined || result.ok) {
						result = await env.notificationService.sendDirect(
							channel,
							{
								event: 'scan_failed',
								title: 'understory test notification',
								summary:
									'This is a test message confirming the channel is configured correctly.',
								sections: [],
								footer: `Channel ${channel.name}`,
							}
						);
					}

					const now = new Date();
					if (result.ok) {
						await env.notifications.channels.markSuccess(
							channel.id,
							now
						);
					} else {
						await env.notifications.channels.markError(
							channel.id,
							result.error,
							now
						);
					}
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'notificationChannel.test',
						targetType: 'notificationChannel',
						targetId: channel.id,
						meta: { ok: result.ok },
					});

					return result.ok
						? { ok: true }
						: {
								ok: false,
								retryable: result.retryable,
								error: result.error,
							};
				},
			});

			const rulesList = route({
				id: 'notifications.rules.list',
				method: 'GET',
				path: '/api/notification-rules',
				policy: { permissions: { notification: ['read'] } },
				rateLimit: 'read',
				params: t.Object({}),
				query: t.Object({
					projectId: t.Optional(t.String({ maxLength: 64 })),
					channelId: t.Optional(t.String({ maxLength: 64 })),
					page: t.Optional(t.Number({ minimum: 1, default: 1 })),
					pageSize: t.Optional(
						t.Number({ minimum: 1, maximum: 200, default: 50 })
					),
				}),
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(RuleView, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				docs: {
					summary: 'Notification rules (projectId "" = all projects)',
					tag: 'Notifications',
				},
				handler: async (ctx) => {
					const page = ctx.query.page ?? 1;
					const pageSize = ctx.query.pageSize ?? 50;
					const all = await env.notifications.rules.list({
						projectId: ctx.query.projectId,
						channelId: ctx.query.channelId,
					});
					return {
						items: all
							.slice((page - 1) * pageSize, page * pageSize)
							.map(toRuleView),
						total: all.length,
						page,
						pageSize,
					};
				},
			});

			const rulesUpsert = route({
				id: 'notifications.rules.upsert',
				method: 'PUT',
				path: '/api/notification-rules',
				policy: { permissions: { notification: ['manage'] } },
				rateLimit: 'write',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Object({
					channelId: t.String({ minLength: 1, maxLength: 64 }),
					/** '' = all projects. */
					projectId: t.String({ maxLength: 64 }),
					eventType: EventType,
					minSeverity: t.Optional(t.Union([Severity, t.Null()])),
					enabled: t.Optional(t.Boolean()),
				}),
				response: RuleView,
				errors: [NotFoundError],
				docs: {
					summary: 'Create or update a rule',
					tag: 'Notifications',
				},
				handler: async (ctx) => {
					const channel = await env.notifications.channels.get(
						ctx.body.channelId
					);
					if (channel === null) {
						throw new NotFoundError(
							'NotificationChannel',
							ctx.body.channelId
						);
					}
					if (ctx.body.projectId !== '') {
						const project = await env.projects.get(
							ctx.body.projectId
						);
						if (project === null) {
							throw new NotFoundError(
								'Project',
								ctx.body.projectId
							);
						}
					}
					const rule = await env.notifications.rules.upsert({
						channelId: ctx.body.channelId,
						projectId: ctx.body.projectId,
						eventType: ctx.body.eventType,
						minSeverity: ctx.body.minSeverity ?? null,
						enabled: ctx.body.enabled,
					});
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'notificationRule.upsert',
						targetType: 'notificationRule',
						targetId: rule.id,
						meta: {
							channelId: rule.channelId,
							projectId: rule.projectId,
							eventType: rule.eventType,
						},
					});
					return toRuleView(rule);
				},
			});

			const rulesDelete = route({
				id: 'notifications.rules.delete',
				method: 'DELETE',
				path: '/api/notification-rules/:ruleId',
				policy: { permissions: { notification: ['manage'] } },
				rateLimit: 'write',
				params: t.Object({
					ruleId: t.String({ minLength: 1, maxLength: 64 }),
				}),
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({ deleted: t.Boolean() }),
				errors: [NotFoundError],
				docs: { summary: 'Delete a rule', tag: 'Notifications' },
				handler: async (ctx) => {
					const deleted = await env.notifications.rules.delete(
						ctx.params.ruleId
					);
					if (!deleted) {
						throw new NotFoundError(
							'NotificationRule',
							ctx.params.ruleId
						);
					}
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'notificationRule.delete',
						targetType: 'notificationRule',
						targetId: ctx.params.ruleId,
					});
					return { deleted };
				},
			});

			const deliveriesList = route({
				id: 'notifications.deliveries.list',
				method: 'GET',
				path: '/api/notification-deliveries',
				policy: { permissions: { notification: ['read'] } },
				rateLimit: 'read',
				params: t.Object({}),
				query: t.Object({
					channelId: t.Optional(t.String({ maxLength: 64 })),
					projectId: t.Optional(t.String({ maxLength: 64 })),
					eventType: t.Optional(EventType),
					status: t.Optional(DeliveryStatus),
					page: t.Optional(t.Number({ minimum: 1, default: 1 })),
					pageSize: t.Optional(
						t.Number({ minimum: 1, maximum: 200, default: 50 })
					),
				}),
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(DeliveryView, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				docs: {
					summary: 'Delivery log (dedupe + retry state)',
					tag: 'Notifications',
				},
				handler: async (ctx) => {
					const page = ctx.query.page ?? 1;
					const pageSize = ctx.query.pageSize ?? 50;
					const result = await env.notifications.deliveries.list({
						channelId: ctx.query.channelId,
						projectId: ctx.query.projectId,
						eventType: ctx.query.eventType,
						status: ctx.query.status,
						page,
						pageSize,
					});
					return {
						items: result.items.map((row) => ({
							id: row.id,
							channelId: row.channelId,
							projectId: row.projectId,
							eventType: row.eventType,
							eventKey: row.eventKey,
							status: row.status,
							attempts: row.attempts,
							nextAttemptAt: row.nextAttemptAt,
							sentAt: row.sentAt,
							error: row.error,
							title: titleOf(row.payloadJson),
							createdAt: row.createdAt,
						})),
						total: result.total,
						page,
						pageSize,
					};
				},
			});

			return {
				routes: [
					channelsList,
					channelsCreate,
					channelsUpdate,
					channelsDelete,
					channelsTest,
					rulesList,
					rulesUpsert,
					rulesDelete,
					deliveriesList,
				] as const,
			};
		},
	});
}
