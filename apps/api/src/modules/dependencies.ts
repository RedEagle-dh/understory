import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';
import { InvalidInputError, NotFoundError } from '../errors';
import {
	DependencyListItem,
	DependencyOccurrence,
	DependencyStatusView,
	DepType,
	PACKAGE_NAME_PATTERN,
	PeerIssueView,
	UpdateKind,
} from '../schemas/dependency';
import { FindingListItem, toFindingListItem } from '../schemas/vulnerability';
import type { DependencySetEntryRow } from '../stores/dependency-sets';
import type { DependencyStatusRow } from '../stores/dependency-status';

const ProjectIdParam = t.Object({
	projectId: t.String({ minLength: 1, maxLength: 64 }),
});

const PACKAGE_NAME_RE = new RegExp(PACKAGE_NAME_PATTERN);

const ListQuery = t.Object({
	q: t.Optional(t.String({ maxLength: 200 })),
	depType: t.Optional(DepType),
	direct: t.Optional(t.Boolean()),
	updateKind: t.Optional(UpdateKind),
	hasVuln: t.Optional(t.Boolean()),
	workspace: t.Optional(t.String({ maxLength: 400 })),
	page: t.Optional(t.Number({ minimum: 1, default: 1 })),
	pageSize: t.Optional(t.Number({ minimum: 1, maximum: 200, default: 50 })),
	sort: t.Optional(
		t.Union([
			t.Literal('name'),
			t.Literal('severity'),
			t.Literal('updateKind'),
		])
	),
});

function toStatusView(row: DependencyStatusRow) {
	return {
		workspace: row.workspace,
		currentVersion: row.currentVersion,
		declaredRange: row.declaredRange,
		wantedVersion: row.wantedVersion,
		latestVersion: row.latestVersion,
		updateKind: row.updateKind,
		deprecatedMessage: row.deprecatedMessage,
		previousLatestVersion: row.previousLatestVersion,
		latestChangedAt: row.latestChangedAt,
	};
}

function toOccurrence(row: DependencySetEntryRow) {
	let peerDeps: Record<string, { range: string; optional: boolean }> | null =
		null;
	if (row.peerDepsJson !== null) {
		try {
			peerDeps = JSON.parse(row.peerDepsJson) as Record<
				string,
				{ range: string; optional: boolean }
			>;
		} catch {
			peerDeps = null;
		}
	}
	return {
		version: row.version,
		workspace: row.workspace,
		depType: row.depType,
		isDirect: row.isDirect,
		depth: row.depth,
		declaredRange: row.declaredRange,
		resolved: row.resolved,
		peerDeps,
	};
}

export function dependenciesModule() {
	return defineModule({
		id: 'dependencies',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			/**
			 * Dependencies are always read from the LAST SUCCESSFUL scan's
			 * dependency set — a running or failed scan must never blank the
			 * view. `null` means the project has never completed a scan.
			 */
			async function resolveSetId(
				projectId: string
			): Promise<string | null> {
				const project = await env.projects.get(projectId);
				if (project === null) {
					throw new NotFoundError('Project', projectId);
				}
				if (project.lastSuccessScanId === null) return null;
				const scan = await env.scans.get(project.lastSuccessScanId);
				return scan?.dependencySetId ?? null;
			}

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
						`"${name}" is not a valid npm package name`
					);
				}
				return name;
			}

			const list = route({
				id: 'dependencies.list',
				method: 'GET',
				path: '/api/projects/:projectId/dependencies',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ProjectIdParam,
				query: ListQuery,
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(DependencyListItem, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				errors: [NotFoundError],
				docs: {
					summary: 'Dependency tree of the last successful scan',
					tag: 'Dependencies',
				},
				handler: async (ctx) => {
					const page = ctx.query.page ?? 1;
					const pageSize = ctx.query.pageSize ?? 50;
					const setId = await resolveSetId(ctx.params.projectId);
					if (setId === null) {
						return { items: [], total: 0, page, pageSize };
					}
					const result = await env.dependencySets.listWithStatus(
						ctx.params.projectId,
						setId,
						{
							q: ctx.query.q,
							depType: ctx.query.depType,
							direct: ctx.query.direct,
							updateKind: ctx.query.updateKind,
							hasVuln: ctx.query.hasVuln,
							workspace: ctx.query.workspace,
							page,
							pageSize,
							sort: ctx.query.sort,
						}
					);
					return { ...result, page, pageSize };
				},
			});

			const get = route({
				id: 'dependencies.get',
				method: 'GET',
				path: '/api/projects/:projectId/dependencies/:name',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: t.Object({
					projectId: t.String({ minLength: 1, maxLength: 64 }),
					name: t.String({ minLength: 1, maxLength: 300 }),
				}),
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({
					name: t.String(),
					occurrences: t.Array(DependencyOccurrence, {
						maxItems: 200,
					}),
					statuses: t.Array(DependencyStatusView, { maxItems: 200 }),
					findings: t.Array(FindingListItem, { maxItems: 200 }),
				}),
				errors: [NotFoundError, InvalidInputError],
				docs: {
					summary: 'One package: versions, status, findings, peers',
					tag: 'Dependencies',
				},
				handler: async (ctx) => {
					const name = decodeName(ctx.params.name);
					const setId = await resolveSetId(ctx.params.projectId);
					const [occurrences, statuses, findings] = await Promise.all(
						[
							setId === null
								? Promise.resolve([])
								: env.dependencySets.entriesForPackage(
										setId,
										name
									),
							env.dependencyStatus.forPackage(
								ctx.params.projectId,
								name
							),
							env.findings.listForPackage(
								ctx.params.projectId,
								name
							),
						]
					);
					if (
						occurrences.length === 0 &&
						statuses.length === 0 &&
						findings.length === 0
					) {
						throw new NotFoundError('Dependency', name);
					}
					return {
						name,
						occurrences: occurrences.map(toOccurrence),
						statuses: statuses.map(toStatusView),
						findings: findings.map(toFindingListItem),
					};
				},
			});

			const outdated = route({
				id: 'dependencies.outdated',
				method: 'GET',
				path: '/api/projects/:projectId/outdated',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ProjectIdParam,
				query: t.Object({
					updateKind: t.Optional(UpdateKind),
					direct: t.Optional(t.Boolean()),
					workspace: t.Optional(t.String({ maxLength: 400 })),
					q: t.Optional(t.String({ maxLength: 200 })),
					page: t.Optional(t.Number({ minimum: 1, default: 1 })),
					pageSize: t.Optional(
						t.Number({ minimum: 1, maximum: 200, default: 50 })
					),
				}),
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(DependencyStatusView, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				errors: [NotFoundError],
				docs: {
					summary: 'Packages with an available update',
					tag: 'Dependencies',
				},
				handler: async (ctx) => {
					const project = await env.projects.get(
						ctx.params.projectId
					);
					if (project === null) {
						throw new NotFoundError(
							'Project',
							ctx.params.projectId
						);
					}
					const page = ctx.query.page ?? 1;
					const pageSize = ctx.query.pageSize ?? 50;
					const result = await env.dependencyStatus.listForProject(
						project.id,
						{
							updateKind:
								ctx.query.updateKind === undefined
									? ['patch', 'minor', 'major']
									: [ctx.query.updateKind],
							isDirect: ctx.query.direct,
							workspace: ctx.query.workspace,
							q: ctx.query.q,
							page,
							pageSize,
						}
					);
					return {
						items: result.items.map(toStatusView),
						total: result.total,
						page,
						pageSize,
					};
				},
			});

			const peerIssues = route({
				id: 'dependencies.peerIssues',
				method: 'GET',
				path: '/api/projects/:projectId/peer-issues',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ProjectIdParam,
				query: t.Object({
					state: t.Optional(
						t.Union([t.Literal('open'), t.Literal('resolved')])
					),
					page: t.Optional(t.Number({ minimum: 1, default: 1 })),
					pageSize: t.Optional(
						t.Number({ minimum: 1, maximum: 200, default: 50 })
					),
				}),
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(PeerIssueView, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				errors: [NotFoundError],
				docs: {
					summary: 'Missing / incompatible peer dependencies',
					tag: 'Dependencies',
				},
				handler: async (ctx) => {
					const project = await env.projects.get(
						ctx.params.projectId
					);
					if (project === null) {
						throw new NotFoundError(
							'Project',
							ctx.params.projectId
						);
					}
					const page = ctx.query.page ?? 1;
					const pageSize = ctx.query.pageSize ?? 50;
					const result = await env.peerIssues.listForProject(
						project.id,
						{
							state: [ctx.query.state ?? 'open'],
							page,
							pageSize,
						}
					);
					return {
						items: result.items.map((row) => ({
							id: row.id,
							packageName: row.packageName,
							requiredBy: row.requiredBy,
							requiredByVersion: row.requiredByVersion,
							requiredRange: row.requiredRange,
							resolvedVersion: row.resolvedVersion,
							kind: row.kind,
							optional: row.optional,
							state: row.state,
						})),
						total: result.total,
						page,
						pageSize,
					};
				},
			});

			return { routes: [list, get, outdated, peerIssues] as const };
		},
	});
}
