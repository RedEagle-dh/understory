import type { LoggerPort } from '@declarativejs/core';
import { ScanInProgressError } from '../errors';
import type { DependencySetsStore } from '../stores/dependency-sets';
import type { NotificationsStore } from '../stores/notifications';
import type { ProjectsStore } from '../stores/projects';
import type { RegistryCacheStore } from '../stores/registry-cache';
import type { ScansStore } from '../stores/scans';
import type { SettingsStore } from '../stores/settings';
import type { ScanService } from './scan-service';

/** Upper bound on one dispatch tick — the minute dispatcher must never queue up. */
const DISPATCH_BATCH = 20;

/** Registry/GitHub cache entries stay a week past expiry (ETag revalidation is free). */
const CACHE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SchedulerServiceDeps {
	projects: ProjectsStore;
	scans: ScansStore;
	dependencySets: DependencySetsStore;
	registryCache: RegistryCacheStore;
	notifications: NotificationsStore;
	settings: SettingsStore;
	scanService: Pick<ScanService, 'runScan' | 'isRunning'>;
	/** Parallel scans per tick (env.SCAN_CONCURRENCY). */
	concurrency: number;
	/** Raw sqlite handle for the PRAGMA maintenance pass. */
	sqlite?: { exec(sql: string): void };
	log?: LoggerPort;
}

export interface DispatchResult {
	dispatched: number;
	skipped: number;
	failed: number;
}

export interface PruneResult {
	scansDeleted: number;
	setsDeleted: number;
	cacheEntriesDeleted: number;
	deliveriesDeleted: number;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createSchedulerService(deps: SchedulerServiceDeps) {
	const log = deps.log;

	/**
	 * Runs every due project through a fixed-width semaphore. Isolation is the
	 * whole point: `runScan` already persists its own failure and backoff, so a
	 * rejected promise here is counted and dropped — one broken project must
	 * never stop the other nineteen from being scanned this minute.
	 */
	async function dispatchDue(now: Date): Promise<DispatchResult> {
		const due = await deps.projects.due(now, DISPATCH_BATCH);
		const result: DispatchResult = {
			dispatched: 0,
			skipped: 0,
			failed: 0,
		};
		if (due.length === 0) return result;

		let cursor = 0;
		async function worker(): Promise<void> {
			while (cursor < due.length) {
				const project = due[cursor];
				cursor += 1;
				if (project === undefined) continue;

				// An in-flight scan (a manual trigger, or a previous tick that
				// ran long) is not an error — it just means this project is
				// already being taken care of.
				if (deps.scanService.isRunning(project.id)) {
					result.skipped += 1;
					continue;
				}

				try {
					const scan = await deps.scanService.runScan(
						project.id,
						'schedule'
					);
					if (scan.status === 'ok') result.dispatched += 1;
					else result.failed += 1;
				} catch (error) {
					if (error instanceof ScanInProgressError) {
						result.skipped += 1;
						continue;
					}
					result.failed += 1;
					log?.error('scheduled scan threw', {
						projectId: project.id,
						error: messageOf(error),
					});
				}
			}
		}

		await Promise.all(
			Array.from(
				{ length: Math.max(1, Math.min(deps.concurrency, due.length)) },
				() => worker()
			)
		);

		log?.info('scan dispatch complete', {
			due: due.length,
			...result,
		});
		return result;
	}

	/**
	 * Retention. Per project: keep the newest N scans plus whatever
	 * `lastScanId`/`lastSuccessScanId` still point at (the projects list would
	 * otherwise render dangling references), then drop dependency sets no
	 * surviving scan references. Finishes with SQLite housekeeping — `optimize`
	 * refreshes stale query-planner statistics, and a TRUNCATE checkpoint is
	 * the only thing that actually shrinks a WAL that a long-running writer
	 * has grown.
	 */
	async function prune(now: Date): Promise<PruneResult> {
		const settings = await deps.settings.get();
		const keep = Math.max(1, settings.retentionScansPerProject);
		const result: PruneResult = {
			scansDeleted: 0,
			setsDeleted: 0,
			cacheEntriesDeleted: 0,
			deliveriesDeleted: 0,
		};

		for (const project of await deps.projects.list()) {
			const rows = await deps.scans.listIdsForRetention(project.id);
			const protectedIds = new Set(
				[project.lastScanId, project.lastSuccessScanId].filter(
					(scanId): scanId is string => scanId !== null
				)
			);

			const doomed = rows
				.slice(keep)
				.filter((row) => !protectedIds.has(row.id))
				.map((row) => row.id);
			result.scansDeleted += await deps.scans.deleteByIds(doomed);

			const doomedSet = new Set(doomed);
			const referenced = [
				...new Set(
					rows
						.filter((row) => !doomedSet.has(row.id))
						.map((row) => row.dependencySetId)
						.filter(
							(setId): setId is string =>
								setId !== null && setId !== ''
						)
				),
			];
			result.setsDeleted += await deps.dependencySets.deleteOrphans(
				project.id,
				referenced
			);
		}

		result.cacheEntriesDeleted = await deps.registryCache.pruneExpired(
			new Date(now.getTime() - CACHE_GRACE_MS)
		);
		result.deliveriesDeleted =
			await deps.notifications.deliveries.pruneOlderThan(
				new Date(
					now.getTime() -
						settings.retentionDeliveryDays * 24 * 60 * 60 * 1000
				)
			);

		try {
			deps.sqlite?.exec('PRAGMA optimize');
			deps.sqlite?.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		} catch (error) {
			log?.warn('sqlite maintenance failed', {
				error: messageOf(error),
			});
		}

		log?.info('retention prune complete', { ...result });
		return result;
	}

	return { dispatchDue, prune };
}

export type SchedulerService = ReturnType<typeof createSchedulerService>;
