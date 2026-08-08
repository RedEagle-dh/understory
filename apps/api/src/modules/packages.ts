import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';
import { InvalidInputError } from '../errors';
import { PACKAGE_NAME_PATTERN } from '../schemas/dependency';
import {
	Ecosystem,
	PackageIndexItem,
	PackageUsageItem,
} from '../schemas/package';

const PACKAGE_NAME_RE = new RegExp(PACKAGE_NAME_PATTERN);

/**
 * The fleet-wide package index.
 *
 * Every other read surface answers "what is in this repository". This one
 * answers the inverse — "which repositories contain this" — which is the
 * question a supply-chain incident actually poses, and the one that previously
 * required opening each project in turn.
 */
export function packagesModule() {
	return defineModule({
		id: 'packages',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			function decodeName(raw: string): string {
				let name: string;
				try {
					name = decodeURIComponent(raw);
				} catch {
					throw new InvalidInputError(
						'package name is not valid percent-encoding'
					);
				}
				if (!PACKAGE_NAME_RE.test(name)) {
					throw new InvalidInputError(
						`"${name}" is not a valid package name`
					);
				}
				return name;
			}

			const list = route({
				id: 'packages.list',
				method: 'GET',
				path: '/api/packages',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: t.Object({}),
				query: t.Object({
					q: t.Optional(t.String({ maxLength: 200 })),
					ecosystem: t.Optional(Ecosystem),
					direct: t.Optional(t.Boolean()),
					hasVuln: t.Optional(t.Boolean()),
					page: t.Optional(t.Number({ minimum: 1, default: 1 })),
					pageSize: t.Optional(
						t.Number({ minimum: 1, maximum: 200, default: 50 })
					),
					sort: t.Optional(
						t.Union([
							t.Literal('name'),
							t.Literal('projects'),
							t.Literal('severity'),
						])
					),
				}),
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(PackageIndexItem, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				errors: [],
				docs: {
					summary: 'Packages in use across every tracked repository',
					tag: 'Packages',
				},
				handler: async (ctx) => {
					const page = ctx.query.page ?? 1;
					const pageSize = ctx.query.pageSize ?? 50;
					const result = await env.packageIndex.search({
						q: ctx.query.q,
						ecosystem: ctx.query.ecosystem,
						direct: ctx.query.direct,
						hasVuln: ctx.query.hasVuln,
						sort: ctx.query.sort,
						page,
						pageSize,
					});
					return { ...result, page, pageSize };
				},
			});

			const usages = route({
				id: 'packages.usages',
				method: 'GET',
				path: '/api/packages/:name/usages',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: t.Object({
					name: t.String({ minLength: 1, maxLength: 300 }),
				}),
				query: t.Object({ ecosystem: t.Optional(Ecosystem) }),
				body: t.Undefined(),
				response: t.Object({
					name: t.String(),
					items: t.Array(PackageUsageItem, { maxItems: 2000 }),
					/** True when the fleet holds more rows than one response may carry. */
					truncated: t.Boolean(),
				}),
				errors: [InvalidInputError],
				docs: {
					summary: 'Every project and version shipping one package',
					tag: 'Packages',
				},
				handler: async (ctx) => {
					const name = decodeName(ctx.params.name);
					const result = await env.packageIndex.usages(name, {
						ecosystem: ctx.query.ecosystem,
					});
					return { name, ...result };
				},
			});

			return { routes: [list, usages] as const };
		},
	});
}
