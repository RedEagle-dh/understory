import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import { GithubHttpError } from '../adapters/github/client';
import type { AppEnv } from '../environment';
import {
	ConflictError,
	GithubError,
	InvalidInputError,
	NotFoundError,
} from '../errors';
import { Severity } from '../schemas/common';
import {
	OWNER_PATTERN,
	ProjectListItem,
	ProjectView,
	REPO_PATTERN,
	ScanSummary,
} from '../schemas/project';
import type { ProjectRow } from '../stores/projects';
import type { ScanRow } from '../stores/scans';

const ProjectIdParam = t.Object({
	projectId: t.String({ minLength: 1, maxLength: 64 }),
});

const BumpKind = t.Union([
	t.Literal('patch'),
	t.Literal('minor'),
	t.Literal('major'),
]);

function parseJsonArray(value: string | null): string[] | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === 'string')
			: null;
	} catch {
		return null;
	}
}

function toProjectView(row: ProjectRow) {
	return {
		id: row.id,
		name: row.name,
		owner: row.owner,
		repo: row.repo,
		branch: row.branch,
		manifestPaths: parseJsonArray(row.manifestPathsJson),
		hasToken: row.githubTokenEnc !== null,
		tokenLast4: row.githubTokenLast4,
		scanIntervalMinutes: row.scanIntervalMinutes,
		paused: row.paused,
		consecutiveFailures: row.consecutiveFailures,
		nextScanAt: row.nextScanAt,
		autoPrEnabled: row.autoPrEnabled,
		autoPrMinSeverity: row.autoPrMinSeverity,
		autoPrMaxBump: row.autoPrMaxBump,
		autoPrKevOverride: row.autoPrKevOverride,
		autoBumpEnabled: row.autoBumpEnabled,
		autoBumpMaxKind: row.autoBumpMaxKind,
		autoBumpMinReleaseAgeHours: row.autoBumpMinReleaseAgeHours,
		prBaseBranch: row.prBaseBranch,
		prLabels: parseJsonArray(row.prLabelsJson),
		regenerateLockfile: row.regenerateLockfile,
		notifyOnNewMajor: row.notifyOnNewMajor,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function toScanSummary(row: ScanRow) {
	return {
		id: row.id,
		status: row.status,
		trigger: row.trigger,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		errorCode: row.errorCode,
	};
}

/** Maps GitHub transport failures onto the API's typed errors. */
function asApiError(error: unknown, context: string): Error {
	if (error instanceof GithubHttpError) {
		if (error.status === 404) {
			return new InvalidInputError(
				`${context}: repository or branch not found (or the token cannot see it)`
			);
		}
		if (error.status === 401 || error.status === 403) {
			return new InvalidInputError(
				`${context}: GitHub rejected the token (HTTP ${error.status})`
			);
		}
		return new GithubError(`${context}: HTTP ${error.status}`);
	}
	if (error instanceof GithubError) return error;
	return new GithubError(
		`${context}: ${error instanceof Error ? error.message : String(error)}`
	);
}

export function projectsModule() {
	return defineModule({
		id: 'projects',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			const list = route({
				id: 'projects.list',
				method: 'GET',
				path: '/api/projects',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({
					projects: t.Array(ProjectListItem, { maxItems: 1000 }),
				}),
				docs: {
					summary: 'All projects with vulnerability/outdated rollups',
					tag: 'Projects',
				},
				handler: async () => {
					// Three grouped queries instead of 3N per-project rollups:
					// severity counts, outdated counts, and one batched lookup
					// of every project's last scan.
					const rows = await env.projects.list();
					const [vulns, outdated, scans] = await Promise.all([
						env.findings.openCountsByProject(),
						env.dependencyStatus.outdatedCountsByProject(),
						env.scans.byIds(
							rows
								.map((row) => row.lastScanId)
								.filter(
									(scanId): scanId is string =>
										scanId !== null
								)
						),
					]);
					const scanById = new Map(
						scans.map((scan) => [scan.id, scan])
					);

					return {
						projects: rows.map((row) => {
							const counts = vulns.get(row.id) ?? {
								critical: 0,
								high: 0,
								moderate: 0,
								low: 0,
							};
							const outdatedCounts = outdated.get(row.id) ?? {
								outdated: 0,
								major: 0,
							};
							const lastScan =
								row.lastScanId === null
									? undefined
									: scanById.get(row.lastScanId);
							return {
								id: row.id,
								name: row.name,
								owner: row.owner,
								repo: row.repo,
								branch: row.branch,
								paused: row.paused,
								vulnCounts: counts,
								outdatedCount: outdatedCounts.outdated,
								majorOutdatedCount: outdatedCounts.major,
								lastScan:
									lastScan === undefined
										? null
										: toScanSummary(lastScan),
							};
						}),
					};
				},
			});

			const get = route({
				id: 'projects.get',
				method: 'GET',
				path: '/api/projects/:projectId',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ProjectIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Composite([
					ProjectView,
					t.Object({ lastScan: t.Union([ScanSummary, t.Null()]) }),
				]),
				errors: [NotFoundError],
				docs: { summary: 'Project detail', tag: 'Projects' },
				handler: async (ctx) => {
					const row = await env.projects.get(ctx.params.projectId);
					if (row === null) {
						throw new NotFoundError(
							'Project',
							ctx.params.projectId
						);
					}
					const lastScan =
						row.lastScanId === null
							? null
							: await env.scans.get(row.lastScanId);
					return {
						...toProjectView(row),
						lastScan:
							lastScan === null ? null : toScanSummary(lastScan),
					};
				},
			});

			const create = route({
				id: 'projects.create',
				method: 'POST',
				path: '/api/projects',
				policy: { permissions: { project: ['create'] } },
				rateLimit: 'write',
				params: t.Object({}),
				query: t.Object({}),
				body: t.Object({
					name: t.Optional(
						t.String({ minLength: 1, maxLength: 120 })
					),
					owner: t.String({ pattern: OWNER_PATTERN }),
					repo: t.String({ pattern: REPO_PATTERN }),
					/** '' = track the repository's default branch. */
					branch: t.Optional(t.String({ maxLength: 255 })),
					token: t.Optional(
						t.String({ minLength: 20, maxLength: 500 })
					),
					scanIntervalMinutes: t.Optional(
						t.Number({ minimum: 5, maximum: 1440 })
					),
				}),
				response: ProjectView,
				successStatus: 201,
				errors: [InvalidInputError, GithubError, ConflictError],
				docs: {
					summary: 'Register a repository (validates reachability)',
					tag: 'Projects',
				},
				handler: async (ctx) => {
					const branch = ctx.body.branch ?? '';
					const token =
						ctx.body.token ?? (await env.github.resolveToken(null));
					const { reader } = env.github.forToken(token);

					let resolvedBranch: string;
					try {
						resolvedBranch = await reader.resolveBranch({
							owner: ctx.body.owner,
							repo: ctx.body.repo,
							branch,
						});
					} catch (error) {
						throw asApiError(
							error,
							`${ctx.body.owner}/${ctx.body.repo}`
						);
					}
					if (branch !== '' && resolvedBranch !== branch) {
						throw new InvalidInputError(
							`branch ${branch} could not be resolved`
						);
					}

					let project: ProjectRow;
					try {
						project = await env.projects.create({
							name:
								ctx.body.name ??
								`${ctx.body.owner}/${ctx.body.repo}`,
							owner: ctx.body.owner,
							repo: ctx.body.repo,
							branch,
							createdBy: ctx.user.id,
							scanIntervalMinutes: ctx.body.scanIntervalMinutes,
						});
					} catch (error) {
						throw new ConflictError(
							`Could not register ${ctx.body.owner}/${ctx.body.repo}${branch === '' ? '' : `@${branch}`}: ${error instanceof Error ? error.message : String(error)}`
						);
					}

					if (ctx.body.token !== undefined) {
						const sealed = await env.secrets.sealProjectToken(
							project.id,
							ctx.body.token
						);
						await env.projects.setToken(
							project.id,
							sealed.sealed,
							sealed.last4
						);
						project = {
							...project,
							githubTokenEnc: sealed.sealed,
							githubTokenLast4: sealed.last4,
						};
					}

					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'project.create',
						targetType: 'project',
						targetId: project.id,
						meta: {
							owner: project.owner,
							repo: project.repo,
							branch,
						},
					});

					return toProjectView(project);
				},
			});

			const update = route({
				id: 'projects.update',
				method: 'PATCH',
				path: '/api/projects/:projectId',
				policy: { permissions: { project: ['update'] } },
				rateLimit: 'write',
				params: ProjectIdParam,
				query: t.Object({}),
				body: t.Object({
					name: t.Optional(
						t.String({ minLength: 1, maxLength: 120 })
					),
					branch: t.Optional(t.String({ maxLength: 255 })),
					manifestPaths: t.Optional(
						t.Union([
							t.Array(t.String({ maxLength: 400 }), {
								maxItems: 100,
							}),
							t.Null(),
						])
					),
					scanIntervalMinutes: t.Optional(
						t.Number({ minimum: 5, maximum: 1440 })
					),
					paused: t.Optional(t.Boolean()),
					autoPrEnabled: t.Optional(t.Boolean()),
					autoPrMinSeverity: t.Optional(Severity),
					autoPrMaxBump: t.Optional(BumpKind),
					autoPrKevOverride: t.Optional(t.Boolean()),
					autoBumpEnabled: t.Optional(t.Boolean()),
					autoBumpMaxKind: t.Optional(BumpKind),
					autoBumpMinReleaseAgeHours: t.Optional(
						// 0 = no cooldown; cap at one year.
						t.Number({ minimum: 0, maximum: 8760 })
					),
					prBaseBranch: t.Optional(
						t.Union([t.String({ maxLength: 255 }), t.Null()])
					),
					prLabels: t.Optional(
						t.Union([
							t.Array(t.String({ maxLength: 60 }), {
								maxItems: 20,
							}),
							t.Null(),
						])
					),
					regenerateLockfile: t.Optional(t.Boolean()),
					notifyOnNewMajor: t.Optional(t.Boolean()),
				}),
				response: ProjectView,
				errors: [NotFoundError],
				docs: { summary: 'Update project settings', tag: 'Projects' },
				handler: async (ctx) => {
					const { manifestPaths, prLabels, ...rest } = ctx.body;
					const patch = {
						...rest,
						...(manifestPaths === undefined
							? {}
							: {
									manifestPathsJson:
										manifestPaths === null
											? null
											: JSON.stringify(manifestPaths),
								}),
						...(prLabels === undefined
							? {}
							: {
									prLabelsJson:
										prLabels === null
											? null
											: JSON.stringify(prLabels),
								}),
					};
					const row = await env.projects.update(
						ctx.params.projectId,
						patch
					);
					if (row === null) {
						throw new NotFoundError(
							'Project',
							ctx.params.projectId
						);
					}
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'project.update',
						targetType: 'project',
						targetId: row.id,
						meta: ctx.body,
					});
					return toProjectView(row);
				},
			});

			const setToken = route({
				id: 'projects.setToken',
				method: 'PUT',
				path: '/api/projects/:projectId/token',
				policy: { permissions: { project: ['update'] } },
				rateLimit: 'write',
				params: ProjectIdParam,
				query: t.Object({}),
				body: t.Object({
					token: t.String({ minLength: 20, maxLength: 500 }),
				}),
				response: t.Object({
					hasToken: t.Boolean(),
					tokenLast4: t.Union([t.String(), t.Null()]),
				}),
				errors: [NotFoundError],
				docs: {
					summary: 'Store a project-scoped GitHub token',
					tag: 'Projects',
				},
				handler: async (ctx) => {
					const row = await env.projects.get(ctx.params.projectId);
					if (row === null) {
						throw new NotFoundError(
							'Project',
							ctx.params.projectId
						);
					}
					const sealed = await env.secrets.sealProjectToken(
						row.id,
						ctx.body.token
					);
					await env.projects.setToken(
						row.id,
						sealed.sealed,
						sealed.last4
					);
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'project.setToken',
						targetType: 'project',
						targetId: row.id,
						meta: { last4: sealed.last4 },
					});
					return { hasToken: true, tokenLast4: sealed.last4 };
				},
			});

			const deleteToken = route({
				id: 'projects.deleteToken',
				method: 'DELETE',
				path: '/api/projects/:projectId/token',
				policy: { permissions: { project: ['update'] } },
				rateLimit: 'write',
				params: ProjectIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({
					hasToken: t.Boolean(),
					tokenLast4: t.Union([t.String(), t.Null()]),
				}),
				errors: [NotFoundError],
				docs: {
					summary: 'Remove the project-scoped GitHub token',
					tag: 'Projects',
				},
				handler: async (ctx) => {
					const row = await env.projects.get(ctx.params.projectId);
					if (row === null) {
						throw new NotFoundError(
							'Project',
							ctx.params.projectId
						);
					}
					await env.projects.setToken(row.id, null, null);
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'project.deleteToken',
						targetType: 'project',
						targetId: row.id,
					});
					return { hasToken: false, tokenLast4: null };
				},
			});

			const remove = route({
				id: 'projects.delete',
				method: 'DELETE',
				path: '/api/projects/:projectId',
				policy: { permissions: { project: ['delete'] } },
				rateLimit: 'write',
				params: ProjectIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({ ok: t.Boolean() }),
				errors: [NotFoundError],
				docs: {
					summary: 'Delete a project and all its data',
					tag: 'Projects',
				},
				handler: async (ctx) => {
					const deleted = await env.projects.delete(
						ctx.params.projectId
					);
					if (!deleted) {
						throw new NotFoundError(
							'Project',
							ctx.params.projectId
						);
					}
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'project.delete',
						targetType: 'project',
						targetId: ctx.params.projectId,
					});
					return { ok: true };
				},
			});

			const testConnection = route({
				id: 'projects.testConnection',
				method: 'POST',
				path: '/api/projects/:projectId/test-connection',
				policy: { permissions: { project: ['update'] } },
				rateLimit: 'costly',
				params: ProjectIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({
					branch: t.String(),
					commitSha: t.String(),
					manifestPaths: t.Array(t.String(), { maxItems: 100 }),
					rateLimitRemaining: t.Union([t.Number(), t.Null()]),
				}),
				errors: [NotFoundError, InvalidInputError, GithubError],
				docs: {
					summary: 'Verify repo access and list detected manifests',
					tag: 'Projects',
				},
				handler: async (ctx) => {
					const row = await env.projects.get(ctx.params.projectId);
					if (row === null) {
						throw new NotFoundError(
							'Project',
							ctx.params.projectId
						);
					}
					const token = await env.github.resolveToken(row);
					const { client, reader } = env.github.forToken(token);
					try {
						const result = await reader.listManifests(
							{
								owner: row.owner,
								repo: row.repo,
								branch: row.branch,
							},
							null
						);
						return {
							branch: result.branch,
							commitSha: result.commitSha,
							manifestPaths: result.paths,
							rateLimitRemaining:
								client.rateLimitRemaining() ?? null,
						};
					} catch (error) {
						throw asApiError(error, `${row.owner}/${row.repo}`);
					}
				},
			});

			return {
				routes: [
					list,
					get,
					create,
					update,
					setToken,
					deleteToken,
					remove,
					testConnection,
				] as const,
			};
		},
	});
}
