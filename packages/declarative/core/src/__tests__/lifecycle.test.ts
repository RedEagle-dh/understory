import { describe, expect, test } from 'bun:test';
import { createShutdownLifecycle, type DrainSlots } from '../lifecycle';
import { createTestDeps } from '../testing';

function recorder(name: string, calls: string[]): DrainSlots {
	return {
		rejectNewRequests: () => {
			calls.push(`${name}:rejectNewRequests`);
		},
		finishRunningHandlers: () => {
			calls.push(`${name}:finishRunningHandlers`);
		},
		closeConsumers: () => {
			calls.push(`${name}:closeConsumers`);
		},
		disconnectClients: () => {
			calls.push(`${name}:disconnectClients`);
		},
		flushOutbox: () => {
			calls.push(`${name}:flushOutbox`);
		},
		dispose: () => {
			calls.push(`${name}:dispose`);
		},
	};
}

describe('createShutdownLifecycle', () => {
	test('runs the ADR-0014 #5 phases in order, participants in order within a phase', async () => {
		const { deps } = createTestDeps();
		const calls: string[] = [];
		const lifecycle = createShutdownLifecycle({
			log: deps.log,
			participants: [recorder('transport', calls), recorder('v2', calls)],
		});

		await lifecycle.shutdown();

		expect(calls).toEqual([
			'transport:rejectNewRequests',
			'v2:rejectNewRequests',
			'transport:finishRunningHandlers',
			'v2:finishRunningHandlers',
			'transport:closeConsumers',
			'v2:closeConsumers',
			'transport:disconnectClients',
			'v2:disconnectClients',
			'transport:flushOutbox',
			'v2:flushOutbox',
			'transport:dispose',
			'v2:dispose',
		]);
	});

	test('participants fill only the slots they own', async () => {
		const { deps } = createTestDeps();
		const calls: string[] = [];
		const lifecycle = createShutdownLifecycle({
			log: deps.log,
			participants: [
				{
					disconnectClients: () => {
						calls.push('ws');
					},
				},
				{
					flushOutbox: () => {
						calls.push('outbox');
					},
				},
			],
		});

		await lifecycle.shutdown();

		expect(calls).toEqual(['ws', 'outbox']);
	});

	test('a throwing or hanging step is logged and never stops the drain', async () => {
		const { deps, logs } = createTestDeps();
		const calls: string[] = [];
		const lifecycle = createShutdownLifecycle({
			log: deps.log,
			stepTimeoutMs: 20,
			participants: [
				{
					rejectNewRequests: () => {
						throw new Error('boom');
					},
					closeConsumers: () =>
						new Promise<void>(() => {
							// hangs forever — must hit the step timeout
						}),
					dispose: () => {
						calls.push('dispose');
					},
				},
			],
		});

		await lifecycle.shutdown();

		expect(calls).toEqual(['dispose']);
		const failures = logs.filter(
			(entry) =>
				entry.message === 'shutdown step failed — continuing drain'
		);
		expect(failures).toHaveLength(2);
	});

	test('shutdown is idempotent: repeated signals await the same run', async () => {
		const { deps } = createTestDeps();
		let runs = 0;
		const lifecycle = createShutdownLifecycle({
			log: deps.log,
			participants: [
				{
					dispose: async () => {
						runs += 1;
						await new Promise((resolve) => setTimeout(resolve, 5));
					},
				},
			],
		});

		expect(lifecycle.isDraining()).toBe(false);
		const first = lifecycle.shutdown();
		expect(lifecycle.isDraining()).toBe(true);
		const second = lifecycle.shutdown();
		await Promise.all([first, second]);

		expect(runs).toBe(1);
	});
});
