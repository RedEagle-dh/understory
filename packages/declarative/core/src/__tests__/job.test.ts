import { describe, expect, test } from 'bun:test';
import {
	createJobFactory,
	defineJobStage,
	type JobContext,
	startJobScheduler,
} from '../job';
import { halt, pipeline, provide } from '../pipeline';
import { createTestDeps } from '../testing';

function bareFactory(deps: ReturnType<typeof createTestDeps>['deps']) {
	return createJobFactory({ pipeline: pipeline<JobContext>(), deps });
}

describe('job()', () => {
	test('rejects invalid schedules at definition time', () => {
		const { deps } = createTestDeps();
		const job = bareFactory(deps);
		expect(() =>
			job({
				id: 'bad-cron',
				schedule: { cron: 'nope' },
				handler: async () => undefined,
			})
		).toThrow('cron');
		expect(() =>
			job({
				id: 'bad-interval',
				schedule: { everyMs: 10 },
				handler: async () => undefined,
			})
		).toThrow('everyMs');
	});

	test('successful run: metrics, span, handler context', async () => {
		const { deps, counters, spans } = createTestDeps();
		const job = bareFactory(deps);
		const triggers: string[] = [];
		const instance = job({
			id: 'heartbeat',
			schedule: { everyMs: 15_000 },
			handler: async (ctx) => {
				triggers.push(ctx.trigger);
				expect(ctx.jobId).toBe('heartbeat');
				expect(ctx.traceparent).not.toBe('');
			},
		});
		const result = await instance.run('manual');
		expect(result.kind).toBe('ok');
		expect(triggers).toEqual(['manual']);
		expect(counters).toContainEqual({
			name: 'job_runs_total',
			labels: { job: 'heartbeat', result: 'ok' },
		});
		expect(spans[0]?.name).toBe('job heartbeat');
		expect(spans[0]?.status).toBe('ok');
	});

	test('failure: captured by the error sink, schedule survives', async () => {
		const { deps, capturedErrors } = createTestDeps();
		const job = bareFactory(deps);
		const instance = job({
			id: 'flaky',
			schedule: { everyMs: 60_000 },
			handler: async () => {
				throw new Error('boom');
			},
		});
		const result = await instance.run('schedule');
		expect(result.kind).toBe('failed');
		expect(capturedErrors).toHaveLength(1);
		expect(capturedErrors[0]?.context.entrypoint).toBe('job');
		expect(capturedErrors[0]?.context.route).toBe('flaky');
		// A second run still works.
		expect((await instance.run('schedule')).kind).toBe('failed');
	});

	test('overlapping tick is skipped, not queued', async () => {
		const { deps, counters } = createTestDeps();
		const job = bareFactory(deps);
		const gate = { open: (): void => undefined };
		const gatePromise = new Promise<void>((resolve) => {
			gate.open = resolve;
		});
		const instance = job({
			id: 'slow',
			schedule: { everyMs: 1_000 },
			handler: async () => gatePromise,
		});
		const first = instance.run('schedule');
		const second = await instance.run('schedule');
		expect(second).toEqual({ kind: 'skipped', reason: 'overlap' });
		expect(counters).toContainEqual({
			name: 'job_runs_total',
			labels: { job: 'slow', result: 'overlap' },
		});
		gate.open();
		expect((await first).kind).toBe('ok');
	});

	test('pipeline halt skips the run (gate, not failure)', async () => {
		const { deps, capturedErrors } = createTestDeps();
		const gated = createJobFactory({
			pipeline: pipeline<JobContext>().use(
				defineJobStage<{ readonly enabled: boolean }>(
					'gate',
					async (decl) =>
						decl.enabled
							? provide({})
							: halt(423, 'DISABLED', 'flag off')
				)
			),
			deps,
		});
		const instance = gated({
			id: 'gated',
			schedule: { everyMs: 60_000 },
			enabled: false,
			handler: async () => {
				throw new Error('must not run');
			},
		});
		const result = await instance.run('schedule');
		expect(result).toEqual({ kind: 'skipped', reason: 'gate:DISABLED' });
		expect(capturedErrors).toHaveLength(0);
	});

	test('timeout aborts the handler and fails the run', async () => {
		const { deps } = createTestDeps();
		const job = createJobFactory({
			pipeline: pipeline<JobContext>(),
			deps,
			defaultTimeoutMs: 20,
		});
		const instance = job({
			id: 'hangs',
			schedule: { everyMs: 60_000 },
			handler: (ctx) =>
				new Promise((resolve) => {
					// Resolves only via abort — simulates a hung handler.
					ctx.signal.addEventListener('abort', () => resolve(), {
						once: true,
					});
					setTimeout(resolve, 10_000).unref?.();
				}),
		});
		const result = await instance.run('schedule');
		expect(result.kind).toBe('failed');
	});
});

describe('startJobScheduler', () => {
	test('rejects duplicate job ids', () => {
		const { deps } = createTestDeps();
		const job = bareFactory(deps);
		const a = job({
			id: 'same',
			schedule: { everyMs: 60_000 },
			handler: async () => undefined,
		});
		expect(() => startJobScheduler({ jobs: [a, a], deps })).toThrow(
			'duplicate job id'
		);
	});

	test('fires an interval job and re-arms; stop clears timers', async () => {
		const { deps } = createTestDeps();
		const job = bareFactory(deps);
		let runs = 0;
		const instance = job({
			id: 'ticker',
			schedule: { everyMs: 1_000 },
			handler: async () => {
				runs += 1;
			},
		});
		const scheduler = startJobScheduler({ jobs: [instance], deps });
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(runs).toBe(1);
		await scheduler.stop();
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(runs).toBe(1);
	}, 5_000);
});
