import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';

const SettingsView = t.Object({
	setupCompleted: t.Boolean(),
	defaultScanIntervalMinutes: t.Number(),
	retentionScansPerProject: t.Number(),
	retentionDeliveryDays: t.Number(),
	hasGithubDefaultToken: t.Boolean(),
});

export function adminModule() {
	return defineModule({
		id: 'admin',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			const me = route({
				id: 'users.me',
				method: 'GET',
				path: '/api/me',
				policy: 'authenticated',
				rateLimit: 'read',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({
					id: t.String(),
					email: t.String(),
					name: t.String(),
					role: t.String(),
				}),
				docs: { summary: 'The signed-in user', tag: 'Users' },
				handler: async (ctx) => ctx.user,
			});

			const settingsGet = route({
				id: 'settings.get',
				method: 'GET',
				path: '/api/admin/settings',
				policy: { permissions: { settings: ['read'] } },
				rateLimit: 'read',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Undefined(),
				response: SettingsView,
				docs: { summary: 'Global settings', tag: 'Admin' },
				handler: async () => env.settings.get(),
			});

			const settingsUpdate = route({
				id: 'settings.update',
				method: 'PATCH',
				path: '/api/admin/settings',
				policy: { permissions: { settings: ['manage'] } },
				rateLimit: 'write',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Object({
					defaultScanIntervalMinutes: t.Optional(
						t.Number({ minimum: 5, maximum: 60 * 24 })
					),
					retentionScansPerProject: t.Optional(
						t.Number({ minimum: 10, maximum: 10_000 })
					),
					retentionDeliveryDays: t.Optional(
						t.Number({ minimum: 1, maximum: 3650 })
					),
				}),
				response: SettingsView,
				docs: { summary: 'Update global settings', tag: 'Admin' },
				handler: async (ctx) => {
					const updated = await env.settings.update(ctx.body);
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'settings.update',
						targetType: 'settings',
						meta: ctx.body,
					});
					return updated;
				},
			});

			const auditLogList = route({
				id: 'auditLog.list',
				method: 'GET',
				path: '/api/admin/audit-log',
				policy: { permissions: { settings: ['read'] } },
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
					entries: t.Array(
						t.Object({
							id: t.String(),
							actorUserId: t.Union([t.String(), t.Null()]),
							action: t.String(),
							targetType: t.String(),
							targetId: t.Union([t.String(), t.Null()]),
							metaJson: t.Union([t.String(), t.Null()]),
							ip: t.Union([t.String(), t.Null()]),
							createdAt: t.Date(),
						}),
						{ maxItems: 200 }
					),
				}),
				docs: { summary: 'Product-level audit log', tag: 'Admin' },
				handler: async (ctx) => {
					const page = ctx.query.page ?? 1;
					const pageSize = ctx.query.pageSize ?? 50;
					const entries = await env.auditLog.list(
						pageSize,
						(page - 1) * pageSize
					);
					return { entries };
				},
			});

			return {
				routes: [
					me,
					settingsGet,
					settingsUpdate,
					auditLogList,
				] as const,
			};
		},
	});
}
