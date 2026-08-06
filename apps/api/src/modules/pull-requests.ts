import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';
import {
	GithubError,
	InvalidInputError,
	NotFoundError,
	PrAlreadyOpenError,
} from '../errors';
import { Pagination } from '../schemas/common';
import {
	PrCreateResultView,
	PrPlanView,
	PrSelectionInputView,
	PullRequestState,
	PullRequestView,
} from '../schemas/pull-request';
import type {
	PullRequestBumpRow,
	PullRequestRow,
} from '../stores/pull-requests';

const ProjectIdParam = t.Object({
	projectId: t.String({ minLength: 1, maxLength: 64 }),
});
const PrIdParam = t.Object({
	prId: t.String({ minLength: 1, maxLength: 64 }),
});

const SelectionsBody = t.Object({
	selections: t.Array(PrSelectionInputView, {
		minItems: 1,
		maxItems: 200,
	}),
});

function toView(row: PullRequestRow, bumps: readonly PullRequestBumpRow[]) {
	return {
		id: row.id,
		projectId: row.projectId,
		number: row.number,
		url: row.url,
		branch: row.branch,
		baseBranch: row.baseBranch,
		kind: row.kind,
		state: row.state,
		title: row.title,
		commitSha: row.commitSha,
		lockfileUpdated: row.lockfileUpdated,
		createdByUserId: row.createdByUserId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		mergedAt: row.mergedAt,
		closedAt: row.closedAt,
		lastSyncedAt: row.lastSyncedAt,
		errorMessage: row.errorMessage,
		bumps: bumps.map((bump) => ({
			packageName: bump.packageName,
			workspace: bump.workspace,
			fromRange: bump.fromRange,
			fromVersion: bump.fromVersion,
			toVersion: bump.toVersion,
			advisoryId: bump.advisoryId,
			findingId: bump.findingId,
		})),
	};
}

/**
 * Version-bump pull requests. `plan` is a pure dry run — the UI shows exactly
 * what `create` will do, including everything that had to be dropped and why —
 * and `create` is the only route that touches a repository.
 */
export function pullRequestsModule() {
	return defineModule({
		id: 'pullRequests',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			const list = route({
				id: 'pullRequests.list',
				method: 'GET',
				path: '/api/projects/:projectId/pull-requests',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ProjectIdParam,
				query: t.Composite([
					Pagination,
					t.Object({ state: t.Optional(PullRequestState) }),
				]),
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(PullRequestView, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				errors: [NotFoundError],
				docs: {
					summary: 'Pull requests opened for a project',
					tag: 'Pull requests',
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
					const result = await env.pullRequests.listForProject(
						project.id,
						{
							...(ctx.query.state === undefined
								? {}
								: { state: [ctx.query.state] }),
							page,
							pageSize,
						}
					);
					return {
						items: result.items.map((entry) =>
							toView(entry.pullRequest, entry.bumps)
						),
						total: result.total,
						page,
						pageSize,
					};
				},
			});

			const plan = route({
				id: 'pullRequests.plan',
				method: 'POST',
				path: '/api/projects/:projectId/pull-requests/plan',
				policy: { permissions: { pr: ['create'] } },
				rateLimit: 'write',
				params: ProjectIdParam,
				query: t.Object({}),
				body: SelectionsBody,
				response: PrPlanView,
				errors: [NotFoundError, InvalidInputError],
				docs: {
					summary: 'Dry-run a bump: manifest edits, drops, conflicts',
					tag: 'Pull requests',
				},
				handler: async (ctx) =>
					env.prService.plan(
						ctx.params.projectId,
						ctx.body.selections
					),
			});

			const create = route({
				id: 'pullRequests.create',
				method: 'POST',
				path: '/api/projects/:projectId/pull-requests',
				policy: { permissions: { pr: ['create'] } },
				rateLimit: 'costly',
				params: ProjectIdParam,
				query: t.Object({}),
				body: SelectionsBody,
				response: PrCreateResultView,
				successStatus: 201,
				errors: [
					NotFoundError,
					InvalidInputError,
					PrAlreadyOpenError,
					GithubError,
				],
				docs: {
					summary: 'Open a version-bump pull request',
					tag: 'Pull requests',
				},
				handler: async (ctx) => {
					const created = await env.prService.create(
						ctx.params.projectId,
						ctx.body.selections,
						{ kind: 'manual', actorUserId: ctx.user.id }
					);
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'pullRequest.create',
						targetType: 'project',
						targetId: ctx.params.projectId,
						meta: {
							pullRequestId: created.id,
							number: created.number,
							url: created.url,
							branch: created.branch,
							lockfileUpdated: created.lockfileUpdated,
							packages: ctx.body.selections.map(
								(selection) => selection.name
							),
						},
					});
					return created;
				},
			});

			const sync = route({
				id: 'pullRequests.sync',
				method: 'POST',
				path: '/api/pull-requests/:prId/sync',
				policy: { permissions: { pr: ['create'] } },
				rateLimit: 'write',
				params: PrIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: PullRequestView,
				errors: [NotFoundError, GithubError],
				docs: {
					summary: 'Refresh one pull request state from GitHub',
					tag: 'Pull requests',
				},
				handler: async (ctx) => {
					const row = await env.prService.syncOneById(
						ctx.params.prId
					);
					const bumps = await env.pullRequests.bumpsFor([row.id]);
					return toView(row, bumps.get(row.id) ?? []);
				},
			});

			return { routes: [list, plan, create, sync] as const };
		},
	});
}
