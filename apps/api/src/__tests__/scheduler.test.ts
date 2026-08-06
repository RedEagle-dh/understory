import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, id, runMigrations, schema } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { ScanInProgressError } from '../errors';
import type { ScanResult } from '../services/scan-service';
import { createSchedulerService } from '../services/scheduler-service';
import { createDependencySetsStore } from '../stores/dependency-sets';
import { createNotificationsStore } from '../stores/notifications';
import { createProjectsStore } from '../stores/projects';
import { createRegistryCacheStore } from '../stores/registry-cache';
import { createScansStore } from '../stores/scans';
import { createSettingsStore } from '../stores/settings';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const EMPTY_COUNTERS = {
	totalDeps: 0,
	directDeps: 0,
	peerDeps: 0,
	vulnCritical: 0,
	vulnHigh: 0,
	vulnModerate: 0,
	vulnLow: 0,
	outdatedCount: 0,
	majorOutdatedCount: 0,
	newFindings: 0,
	resolvedFindings: 0,
};

interface FakeScanService {
	isRunning(projectId: string): boolean;
	runScan(projectId: string, trigger: string): Promise<ScanResult>;
	calls: string[];
	maxInFlight: number;
	running: Set<string>;
	/** Projects whose `runScan` rejects instead of returning a failed result. */
	throwFor: Set<string>;
	/** Projects reported as already in flight. */
	busy: Set<string>;
	/** Projects whose scan resolves with status 'failed'. */
	failFor: Set<string>;
	delayMs: number;
}

function makeScanService(): FakeScanService {
	const service: FakeScanService = {
		calls: [],
		maxInFlight: 0,
		running: new Set(),
		throwFor: new Set(),
		busy: new Set(),
		failFor: new Set(),
		delayMs: 5,
		isRunning: (projectId) => service.busy.has(projectId),
		async runScan(projectId) {
			service.calls.push(projectId);
			service.running.add(projectId);
			service.maxInFlight = Math.max(
				service.maxInFlight,
				service.running.size
			);
			try {
				await new Promise((resolve) =>
					setTimeout(resolve, service.delayMs)
				);
				if (service.throwFor.has(projectId)) {
					throw new Error(`boom ${projectId}`);
				}
				return {
					scanId: id(),
					projectId,
					status: service.failFor.has(projectId) ? 'failed' : 'ok',
					depsReused: false,
					counters: EMPTY_COUNTERS,
					warnings: [],
				};
			} finally {
				service.running.delete(projectId);
			}
		},
	};
	return service;
}

function makeHarness(concurrency = 3) {
	const { db, sqlite } = createDb(':memory:');
	runMigrations(db);
	db.insert(schema.appSettings)
		.values({ id: 1, createdAt: new Date(), updatedAt: new Date() })
		.run();

	const stores = {
		projects: createProjectsStore(db),
		scans: createScansStore(db),
		dependencySets: createDependencySetsStore(db),
		registryCache: createRegistryCacheStore(db),
		settings: createSettingsStore(db),
		notifications: createNotificationsStore(db, {
			async seal(_channelId, config) {
				return JSON.stringify(config);
			},
			async open(_channelId, sealed) {
				return JSON.parse(sealed) as Record<string, unknown>;
			},
		}),
	};

	const scanService = makeScanService();
	const scheduler = createSchedulerService({
		...stores,
		scanService,
		concurrency,
		sqlite,
	});

	return { db, sqlite, stores, scanService, scheduler };
}

async function makeProjects(
	harness: ReturnType<typeof makeHarness>,
	count: number
) {
	const projects = [];
	for (let index = 0; index < count; index += 1) {
		projects.push(
			await harness.stores.projects.create({
				name: `project-${index}`,
				owner: 'acme',
				repo: `repo-${index}`,
				branch: '',
			})
		);
	}
	return projects;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('scheduler dispatch', () => {
	let harness: ReturnType<typeof makeHarness>;

	beforeEach(() => {
		harness = makeHarness();
	});

	test('dispatches every due project and isolates a throwing one', async () => {
		const projects = await makeProjects(harness, 3);
		const doomed = projects[1];
		if (doomed === undefined) throw new Error('fixture');
		harness.scanService.throwFor.add(doomed.id);

		const result = await harness.scheduler.dispatchDue(
			new Date(Date.now() + 1000)
		);

		expect(harness.scanService.calls.sort()).toEqual(
			projects.map((project) => project.id).sort()
		);
		expect(result).toEqual({ dispatched: 2, skipped: 0, failed: 1 });
	});

	test('a failed ScanResult is counted, not thrown', async () => {
		const projects = await makeProjects(harness, 2);
		const failing = projects[0];
		if (failing === undefined) throw new Error('fixture');
		harness.scanService.failFor.add(failing.id);

		const result = await harness.scheduler.dispatchDue(
			new Date(Date.now() + 1000)
		);
		expect(result).toEqual({ dispatched: 1, skipped: 0, failed: 1 });
	});

	test('never exceeds the configured concurrency', async () => {
		await makeProjects(harness, 6);
		harness.scanService.delayMs = 20;

		const result = await harness.scheduler.dispatchDue(
			new Date(Date.now() + 1000)
		);

		expect(result.dispatched).toBe(6);
		expect(harness.scanService.maxInFlight).toBeLessThanOrEqual(3);
		expect(harness.scanService.maxInFlight).toBeGreaterThan(1);
	});

	test('projects already scanning are skipped, not failed', async () => {
		const projects = await makeProjects(harness, 3);
		const busy = projects[2];
		if (busy === undefined) throw new Error('fixture');
		harness.scanService.busy.add(busy.id);

		const result = await harness.scheduler.dispatchDue(
			new Date(Date.now() + 1000)
		);

		expect(result).toEqual({ dispatched: 2, skipped: 1, failed: 0 });
		expect(harness.scanService.calls).not.toContain(busy.id);
	});

	test('a ScanInProgressError race counts as a skip', async () => {
		const projects = await makeProjects(harness, 1);
		const project = projects[0];
		if (project === undefined) throw new Error('fixture');
		harness.scanService.runScan = async () => {
			throw new ScanInProgressError(project.id);
		};

		const result = await harness.scheduler.dispatchDue(
			new Date(Date.now() + 1000)
		);
		expect(result).toEqual({ dispatched: 0, skipped: 1, failed: 0 });
	});
});

describe('scheduler retention', () => {
	test('keeps the newest N scans plus the protected pointers', async () => {
		const harness = makeHarness();
		await harness.stores.settings.update({
			retentionScansPerProject: 50,
			retentionDeliveryDays: 30,
		});
		const [project] = await makeProjects(harness, 1);
		if (project === undefined) throw new Error('fixture');

		// Two dependency sets: the newest scans point at `keptSet`, only the
		// oldest (about to be pruned) scans point at `orphanSet`.
		const keptSet = id();
		const orphanSet = id();
		for (const [setId, lockHash] of [
			[keptSet, 'hash-kept'],
			[orphanSet, 'hash-orphan'],
		] as const) {
			harness.db
				.insert(schema.dependencySets)
				.values({
					id: setId,
					projectId: project.id,
					lockHash,
					manager: 'npm',
					packageCount: 1,
					directCount: 1,
					createdAt: new Date(),
					firstScanId: 'seed',
				})
				.run();
		}

		const base = Date.now() - 250 * 60_000;
		const scanIds: string[] = [];
		for (let index = 0; index < 250; index += 1) {
			const scanId = id();
			scanIds.push(scanId);
			harness.db
				.insert(schema.scans)
				.values({
					id: scanId,
					projectId: project.id,
					trigger: 'schedule',
					status: 'ok',
					startedAt: new Date(base + index * 60_000),
					dependencySetId: index < 100 ? orphanSet : keptSet,
				})
				.run();
		}

		// The oldest scan is still referenced by the project row, so retention
		// must spare it even though it is 200 scans past the cutoff.
		const oldest = scanIds[0];
		const newest = scanIds.at(-1);
		if (oldest === undefined || newest === undefined) {
			throw new Error('fixture');
		}
		harness.db
			.update(schema.projects)
			.set({ lastScanId: newest, lastSuccessScanId: oldest })
			.where(eq(schema.projects.id, project.id))
			.run();

		const result = await harness.scheduler.prune(new Date());

		const remaining = await harness.db
			.select({ id: schema.scans.id })
			.from(schema.scans);
		expect(remaining).toHaveLength(51);
		expect(remaining.map((row) => row.id)).toContain(oldest);
		expect(remaining.map((row) => row.id)).toContain(newest);
		expect(result.scansDeleted).toBe(199);

		// `orphanSet` is only referenced by deleted scans — except by the
		// protected oldest one, which keeps it alive. Verify the protection
		// propagates through to the sets.
		const sets = await harness.db
			.select({ id: schema.dependencySets.id })
			.from(schema.dependencySets);
		expect(sets.map((row) => row.id).sort()).toEqual(
			[keptSet, orphanSet].sort()
		);
	});

	test('drops dependency sets no surviving scan references', async () => {
		const harness = makeHarness();
		await harness.stores.settings.update({ retentionScansPerProject: 10 });
		const [project] = await makeProjects(harness, 1);
		if (project === undefined) throw new Error('fixture');

		const orphanSet = id();
		harness.db
			.insert(schema.dependencySets)
			.values({
				id: orphanSet,
				projectId: project.id,
				lockHash: 'hash-orphan',
				manager: 'npm',
				packageCount: 1,
				directCount: 1,
				createdAt: new Date(),
				firstScanId: 'seed',
			})
			.run();

		const base = Date.now() - 30 * 60_000;
		for (let index = 0; index < 30; index += 1) {
			harness.db
				.insert(schema.scans)
				.values({
					id: id(),
					projectId: project.id,
					trigger: 'schedule',
					status: 'ok',
					startedAt: new Date(base + index * 60_000),
					// Only the 20 oldest (all pruned) reference the set.
					dependencySetId: index < 20 ? orphanSet : null,
				})
				.run();
		}

		const result = await harness.scheduler.prune(new Date());
		expect(result.setsDeleted).toBe(1);
		const sets = await harness.db.select().from(schema.dependencySets);
		expect(sets).toHaveLength(0);
	});

	test('prunes expired cache entries and settled old deliveries only', async () => {
		const harness = makeHarness();
		await harness.stores.settings.update({ retentionDeliveryDays: 7 });

		const channel = await harness.stores.notifications.channels.create({
			name: 'ops',
			type: 'discord_webhook',
			config: { webhookUrl: 'https://discord.com/api/webhooks/1/token' },
			configPublic: { host: 'discord.com', webhookId: '1' },
		});

		const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
		for (const [status, eventKey] of [
			['sent', 'old-sent'],
			['failed', 'old-failed'],
			['pending', 'old-pending'],
		] as const) {
			harness.db
				.insert(schema.notificationDeliveries)
				.values({
					id: id(),
					channelId: channel.id,
					projectId: null,
					eventType: 'scan_failed',
					eventKey,
					status,
					attempts: 1,
					createdAt: longAgo,
				})
				.run();
		}
		harness.db
			.insert(schema.notificationDeliveries)
			.values({
				id: id(),
				channelId: channel.id,
				projectId: null,
				eventType: 'scan_failed',
				eventKey: 'recent-sent',
				status: 'sent',
				attempts: 1,
				createdAt: new Date(),
			})
			.run();

		await harness.stores.registryCache.set('stale', {
			body: '{}',
			fetchedAt: longAgo,
			expiresAt: longAgo,
		});
		await harness.stores.registryCache.set('fresh', {
			body: '{}',
			fetchedAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
		});

		const result = await harness.scheduler.prune(new Date());

		expect(result.deliveriesDeleted).toBe(2);
		expect(result.cacheEntriesDeleted).toBe(1);
		const deliveries = await harness.db
			.select({ eventKey: schema.notificationDeliveries.eventKey })
			.from(schema.notificationDeliveries);
		expect(deliveries.map((row) => row.eventKey).sort()).toEqual([
			'old-pending',
			'recent-sent',
		]);
	});
});
