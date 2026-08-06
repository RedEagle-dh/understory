import { defineModule } from '@declarativejs/core/app';
import type { AppEnv } from '../environment';

/**
 * The scheduled half of the app. No routes: a job module declares cadence and
 * hands the work to a service, exactly as a route module hands it to a store.
 *
 * `scan.dispatch` runs every minute on purpose. The requirement is hourly *per
 * project*, and a single hourly tick would fire every project at once — the
 * thundering herd. A one-minute dispatcher whose only work is one indexed
 * query over `(paused, next_scan_at)` costs microseconds, spreads load across
 * the hour via each project's `scanOffsetSeconds`, and leaves `nextScanAt` as
 * the single source of truth for cadence, backoff and "scan now". The
 * framework skips overlapping ticks, so a long batch cannot stack up.
 */
export function jobsModule() {
	return defineModule({
		id: 'jobs',
		build: (env: AppEnv) => {
			const job = env.job;

			const scanDispatch = job({
				id: 'scan.dispatch',
				schedule: { cron: '* * * * *' },
				timeoutMs: 15 * 60_000,
				handler: async (ctx) => {
					const result = await env.schedulerService.dispatchDue(
						new Date()
					);
					if (
						result.dispatched + result.skipped + result.failed >
						0
					) {
						ctx.log.info('scan dispatch tick', { ...result });
					}
				},
			});

			const notificationsRetry = job({
				id: 'notifications.retry',
				schedule: { cron: '*/5 * * * *' },
				timeoutMs: 5 * 60_000,
				handler: async (ctx) => {
					const result = await env.notificationService.retryFailed(
						new Date()
					);
					if (result.retried > 0) {
						ctx.log.info('notification retry tick', { ...result });
					}
				},
			});

			const notificationsDigest = job({
				id: 'notifications.digest',
				schedule: { cron: '0 8 * * *' },
				timeoutMs: 5 * 60_000,
				handler: async (ctx) => {
					const result =
						await env.notificationService.sendOutdatedDigests();
					ctx.log.info('outdated digest tick', { ...result });
				},
			});

			const prSync = job({
				id: 'pr.sync',
				schedule: { cron: '*/15 * * * *' },
				timeoutMs: 5 * 60_000,
				handler: async (ctx) => {
					const result = await env.prService.syncOpen();
					if (result.transitioned > 0) {
						ctx.log.info('pull request sync tick', { ...result });
					}
				},
			});

			const advisoryRefresh = job({
				id: 'advisory.refresh',
				schedule: { cron: '17 3 * * *' },
				timeoutMs: 20 * 60_000,
				handler: async (ctx) => {
					const result = await env.advisoryRefreshService.refresh(
						new Date()
					);
					ctx.log.info('advisory refresh tick', { ...result });
				},
			});

			const retentionPrune = job({
				id: 'retention.prune',
				schedule: { cron: '40 4 * * *' },
				timeoutMs: 10 * 60_000,
				handler: async (ctx) => {
					const result = await env.schedulerService.prune(new Date());
					ctx.log.info('retention prune tick', { ...result });
				},
			});

			return {
				jobs: [
					scanDispatch,
					prSync,
					notificationsRetry,
					notificationsDigest,
					advisoryRefresh,
					retentionPrune,
				] as const,
			};
		},
	});
}
