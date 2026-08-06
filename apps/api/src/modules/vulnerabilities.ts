import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';
import { InvalidInputError, NotFoundError } from '../errors';
import { Severity, SeverityCounts } from '../schemas/common';
import {
	AdvisoryView,
	FindingListItem,
	FindingState,
	toAdvisoryView,
	toFindingListItem,
} from '../schemas/vulnerability';

const ProjectIdParam = t.Object({
	projectId: t.String({ minLength: 1, maxLength: 64 }),
});
const FindingIdParam = t.Object({
	findingId: t.String({ minLength: 1, maxLength: 64 }),
});

export function vulnerabilitiesModule() {
	return defineModule({
		id: 'vulnerabilities',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			const list = route({
				id: 'vulnerabilities.list',
				method: 'GET',
				path: '/api/projects/:projectId/vulnerabilities',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ProjectIdParam,
				query: t.Object({
					severity: t.Optional(Severity),
					state: t.Optional(FindingState),
					direct: t.Optional(t.Boolean()),
					hasFix: t.Optional(t.Boolean()),
					q: t.Optional(t.String({ maxLength: 200 })),
					page: t.Optional(t.Number({ minimum: 1, default: 1 })),
					pageSize: t.Optional(
						t.Number({ minimum: 1, maximum: 200, default: 50 })
					),
				}),
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(FindingListItem, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				errors: [NotFoundError],
				docs: {
					summary: 'Findings for a project (open by default)',
					tag: 'Vulnerabilities',
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
					const result = await env.findings.listForProject(
						project.id,
						{
							severity:
								ctx.query.severity === undefined
									? undefined
									: [ctx.query.severity],
							state: [ctx.query.state ?? 'open'],
							isDirect: ctx.query.direct,
							hasFix: ctx.query.hasFix,
							q: ctx.query.q,
							page,
							pageSize,
						}
					);
					return {
						items: result.items.map(toFindingListItem),
						total: result.total,
						page,
						pageSize,
					};
				},
			});

			const summary = route({
				id: 'vulnerabilities.summary',
				method: 'GET',
				path: '/api/projects/:projectId/vulnerabilities/summary',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ProjectIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({
					open: SeverityCounts,
					byState: t.Object({
						open: t.Number(),
						resolved: t.Number(),
						ignored: t.Number(),
					}),
				}),
				errors: [NotFoundError],
				docs: {
					summary: 'Severity + state rollup',
					tag: 'Vulnerabilities',
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
					const [open, ...states] = await Promise.all([
						env.findings.openCounts(project.id),
						env.findings.listForProject(project.id, {
							state: ['open'],
							page: 1,
							pageSize: 1,
						}),
						env.findings.listForProject(project.id, {
							state: ['resolved'],
							page: 1,
							pageSize: 1,
						}),
						env.findings.listForProject(project.id, {
							state: ['ignored'],
							page: 1,
							pageSize: 1,
						}),
					]);
					return {
						open,
						byState: {
							open: states[0]?.total ?? 0,
							resolved: states[1]?.total ?? 0,
							ignored: states[2]?.total ?? 0,
						},
					};
				},
			});

			const get = route({
				id: 'vulnerabilities.get',
				method: 'GET',
				path: '/api/findings/:findingId',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: FindingIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Composite([
					FindingListItem,
					t.Object({ advisory: AdvisoryView }),
				]),
				errors: [NotFoundError],
				docs: {
					summary: 'Finding detail with full advisory',
					tag: 'Vulnerabilities',
				},
				handler: async (ctx) => {
					const finding = await env.findings.byId(
						ctx.params.findingId
					);
					if (finding === null) {
						throw new NotFoundError(
							'Finding',
							ctx.params.findingId
						);
					}
					const detail = await env.advisories.advisoryById(
						finding.advisoryId
					);
					if (detail === null) {
						throw new NotFoundError('Advisory', finding.advisoryId);
					}
					return {
						...toFindingListItem({
							finding,
							advisorySummary: detail.advisory.summary,
							advisoryUrl: detail.advisory.url,
							advisoryCvssScore: detail.advisory.cvssScore,
						}),
						advisory: toAdvisoryView(detail),
					};
				},
			});

			const ignore = route({
				id: 'vulnerabilities.ignore',
				method: 'POST',
				path: '/api/findings/:findingId/ignore',
				policy: { permissions: { project: ['update'] } },
				rateLimit: 'write',
				params: FindingIdParam,
				query: t.Object({}),
				body: t.Object({
					reason: t.String({ minLength: 1, maxLength: 500 }),
					ignoreUntil: t.Optional(t.String({ maxLength: 40 })),
				}),
				response: FindingListItem,
				errors: [NotFoundError, InvalidInputError],
				docs: {
					summary: 'Mute a finding (optionally until a date)',
					tag: 'Vulnerabilities',
				},
				handler: async (ctx) => {
					let ignoreUntil: Date | null = null;
					if (ctx.body.ignoreUntil !== undefined) {
						const parsed = Date.parse(ctx.body.ignoreUntil);
						if (Number.isNaN(parsed)) {
							throw new InvalidInputError(
								'ignoreUntil must be an ISO date'
							);
						}
						ignoreUntil = new Date(parsed);
					}
					const finding = await env.findings.ignore(
						ctx.params.findingId,
						{
							actorUserId: ctx.user.id,
							reason: ctx.body.reason,
							ignoreUntil,
						}
					);
					if (finding === null) {
						throw new NotFoundError(
							'Finding',
							ctx.params.findingId
						);
					}
					const detail = await env.advisories.advisoryById(
						finding.advisoryId
					);
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'finding.ignore',
						targetType: 'finding',
						targetId: finding.id,
						meta: {
							reason: ctx.body.reason,
							ignoreUntil: ctx.body.ignoreUntil,
						},
					});
					return toFindingListItem({
						finding,
						advisorySummary: detail?.advisory.summary ?? '',
						advisoryUrl: detail?.advisory.url ?? null,
						advisoryCvssScore: detail?.advisory.cvssScore ?? null,
					});
				},
			});

			const unignore = route({
				id: 'vulnerabilities.unignore',
				method: 'DELETE',
				path: '/api/findings/:findingId/ignore',
				policy: { permissions: { project: ['update'] } },
				rateLimit: 'write',
				params: FindingIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: FindingListItem,
				errors: [NotFoundError],
				docs: { summary: 'Un-mute a finding', tag: 'Vulnerabilities' },
				handler: async (ctx) => {
					const finding = await env.findings.unignore(
						ctx.params.findingId
					);
					if (finding === null) {
						throw new NotFoundError(
							'Finding',
							ctx.params.findingId
						);
					}
					const detail = await env.advisories.advisoryById(
						finding.advisoryId
					);
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'finding.unignore',
						targetType: 'finding',
						targetId: finding.id,
					});
					return toFindingListItem({
						finding,
						advisorySummary: detail?.advisory.summary ?? '',
						advisoryUrl: detail?.advisory.url ?? null,
						advisoryCvssScore: detail?.advisory.cvssScore ?? null,
					});
				},
			});

			const advisoryGet = route({
				id: 'advisories.get',
				method: 'GET',
				path: '/api/advisories/:advisoryId',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: t.Object({
					advisoryId: t.String({ minLength: 1, maxLength: 100 }),
				}),
				query: t.Object({}),
				body: t.Undefined(),
				response: AdvisoryView,
				errors: [NotFoundError],
				docs: {
					summary: 'Global advisory detail (id or alias)',
					tag: 'Vulnerabilities',
				},
				handler: async (ctx) => {
					const detail = await env.advisories.advisoryById(
						ctx.params.advisoryId
					);
					if (detail === null) {
						throw new NotFoundError(
							'Advisory',
							ctx.params.advisoryId
						);
					}
					return toAdvisoryView(detail);
				},
			});

			return {
				routes: [
					list,
					summary,
					get,
					ignore,
					unignore,
					advisoryGet,
				] as const,
			};
		},
	});
}
