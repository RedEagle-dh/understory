import { t } from '@declarativejs/core';
import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';
import { NotFoundError, ScanInProgressError } from '../errors';
import { Pagination } from '../schemas/common';
import { ScanDetail, ScanDiffView, ScanListItem } from '../schemas/scan';
import { buildScanDiff } from '../services/scan-diff';
import type { ScanRow } from '../stores/scans';

const ProjectIdParam = t.Object({
	projectId: t.String({ minLength: 1, maxLength: 64 }),
});
const ScanIdParam = t.Object({
	scanId: t.String({ minLength: 1, maxLength: 64 }),
});

function parseWarnings(value: string | null): string[] {
	if (value === null) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed
					.filter((item): item is string => typeof item === 'string')
					.slice(0, 50)
			: [];
	} catch {
		return [];
	}
}

function toListItem(row: ScanRow) {
	return {
		id: row.id,
		projectId: row.projectId,
		status: row.status,
		trigger: row.trigger,
		commitSha: row.commitSha,
		branch: row.branch,
		depsReused: row.depsReused,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		durationMs: row.durationMs,
		errorCode: row.errorCode,
		warnings: parseWarnings(row.warningsJson),
		totalDeps: row.totalDeps,
		directDeps: row.directDeps,
		peerDeps: row.peerDeps,
		vulnCritical: row.vulnCritical,
		vulnHigh: row.vulnHigh,
		vulnModerate: row.vulnModerate,
		vulnLow: row.vulnLow,
		outdatedCount: row.outdatedCount,
		majorOutdatedCount: row.majorOutdatedCount,
		newFindings: row.newFindings,
		resolvedFindings: row.resolvedFindings,
	};
}

export function scansModule() {
	return defineModule({
		id: 'scans',
		build: (env: AppEnv) => {
			const route = env.surfaces.authed;

			const list = route({
				id: 'scans.list',
				method: 'GET',
				path: '/api/projects/:projectId/scans',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ProjectIdParam,
				query: Pagination,
				body: t.Undefined(),
				response: t.Object({
					items: t.Array(ScanListItem, { maxItems: 200 }),
					total: t.Number(),
					page: t.Number(),
					pageSize: t.Number(),
				}),
				errors: [NotFoundError],
				docs: { summary: 'Scan history for a project', tag: 'Scans' },
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
					const [rows, total] = await Promise.all([
						env.scans.listForProject(
							project.id,
							pageSize,
							(page - 1) * pageSize
						),
						env.scans.countForProject(project.id),
					]);
					return {
						items: rows.map(toListItem),
						total,
						page,
						pageSize,
					};
				},
			});

			const get = route({
				id: 'scans.get',
				method: 'GET',
				path: '/api/scans/:scanId',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ScanIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: ScanDetail,
				errors: [NotFoundError],
				docs: { summary: 'Scan detail incl. counters', tag: 'Scans' },
				handler: async (ctx) => {
					const scan = await env.scans.get(ctx.params.scanId);
					if (scan === null) {
						throw new NotFoundError('Scan', ctx.params.scanId);
					}
					// A scan whose project has been deleted is not readable.
					const project = await env.projects.get(scan.projectId);
					if (project === null) {
						throw new NotFoundError('Scan', ctx.params.scanId);
					}
					return {
						...toListItem(scan),
						dependencySetId: scan.dependencySetId,
						lockHash: scan.lockHash,
						errorMessage: scan.errorMessage,
						triggeredBy: scan.triggeredBy,
					};
				},
			});

			const trigger = route({
				id: 'scans.trigger',
				method: 'POST',
				path: '/api/projects/:projectId/scans',
				policy: { permissions: { project: ['scan'] } },
				rateLimit: 'costly',
				params: ProjectIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: t.Object({ scanId: t.String() }),
				successStatus: 202,
				errors: [NotFoundError, ScanInProgressError],
				docs: {
					summary: 'Queue a manual scan (202, runs in background)',
					tag: 'Scans',
				},
				handler: async (ctx) => {
					// `startScan` awaits only the `scans` row insert, so the id
					// is real by the time we answer; the pipeline itself keeps
					// running after the response is sent.
					const started = await env.scanService.startScan(
						ctx.params.projectId,
						'manual',
						ctx.user.id
					);
					started.completed.catch((error: unknown) => {
						ctx.log.error('detached scan crashed', {
							projectId: ctx.params.projectId,
							scanId: started.scanId,
							error:
								error instanceof Error
									? error.message
									: String(error),
						});
					});
					await env.auditLog.record({
						actorUserId: ctx.user.id,
						action: 'scan.trigger',
						targetType: 'project',
						targetId: ctx.params.projectId,
						meta: { scanId: started.scanId },
					});
					return { scanId: started.scanId };
				},
			});

			const diff = route({
				id: 'scans.diff',
				method: 'GET',
				path: '/api/scans/:scanId/diff',
				policy: { permissions: { project: ['read'] } },
				rateLimit: 'read',
				params: ScanIdParam,
				query: t.Object({}),
				body: t.Undefined(),
				response: ScanDiffView,
				errors: [NotFoundError],
				docs: {
					summary: 'New / resolved findings and new majors',
					tag: 'Scans',
				},
				handler: async (ctx) => {
					const scan = await env.scans.get(ctx.params.scanId);
					if (scan === null) {
						throw new NotFoundError('Scan', ctx.params.scanId);
					}
					const project = await env.projects.get(scan.projectId);
					if (project === null) {
						throw new NotFoundError('Scan', ctx.params.scanId);
					}
					const event = await buildScanDiff(
						{
							findings: env.findings,
							dependencyStatus: env.dependencyStatus,
						},
						project,
						scan.id,
						scan.startedAt
					);
					return {
						newFindings: event.newFindings,
						resolvedFindings: event.resolvedFindings,
						newMajors: event.newMajors,
					};
				},
			});

			return { routes: [list, get, trigger, diff] as const };
		},
	});
}
