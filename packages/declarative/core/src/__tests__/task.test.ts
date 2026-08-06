import { describe, expect, test } from 'bun:test';
import { Type as t } from '@sinclair/typebox';
import { ValidationFailedError } from '../errors';
import {
	createInMemoryTaskStore,
	createTaskFactory,
	type TaskRunRecord,
} from '../task';
import { createTestDeps } from '../testing';

interface DemoScope {
	readonly tenantLabel: string;
}

async function waitFor(
	read: () => Promise<TaskRunRecord | null>,
	done: (record: TaskRunRecord) => boolean
): Promise<TaskRunRecord> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const record = await read();
		if (record !== null && done(record)) return record;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('task did not reach the expected state');
}

describe('task()', () => {
	test('start validates input against the schema', async () => {
		const { deps } = createTestDeps();
		const task = createTaskFactory({
			deps,
			store: createInMemoryTaskStore(),
		});
		const instance = task({
			id: 'export',
			input: t.Object({ batchSize: t.Number({ minimum: 1 }) }),
			handler: async () => 'ok',
		});
		expect(
			instance.start(
				{ batchSize: 0 },
				{ scope: { tenantLabel: 'org-1' } }
			)
		).rejects.toBeInstanceOf(ValidationFailedError);
	});

	test('lifecycle: pending -> running -> progress -> done, onUpdate sees each', async () => {
		const { deps } = createTestDeps();
		const store = createInMemoryTaskStore();
		const task = createTaskFactory({ deps, store });
		const updates: { status: string; current?: number }[] = [];
		const scopes = new Set<string>();
		const instance = task({
			id: 'export',
			input: t.Object({ items: t.Number() }),
			onUpdate: (record, scope: DemoScope) => {
				scopes.add(scope.tenantLabel);
				updates.push({
					status: record.status,
					current: record.progress?.current,
				});
			},
			handler: async (ctx) => {
				for (let index = 1; index <= ctx.input.items; index += 1) {
					await ctx.reportProgress({
						current: index,
						total: ctx.input.items,
					});
				}
				return { exported: ctx.input.items };
			},
		});
		const { runId } = await instance.start(
			{ items: 3 },
			{
				scope: { tenantLabel: 'org-1' },
				tenantId: 'org-1',
				actorId: 'user-1',
			}
		);
		const finished = await waitFor(
			() => instance.get(runId),
			(record) => record.status === 'done'
		);
		expect(finished.result).toEqual({ exported: 3 });
		expect(finished.tenantId).toBe('org-1');
		expect(finished.actorId).toBe('user-1');
		expect(finished.progress).toEqual({ current: 3, total: 3 });
		expect(scopes).toEqual(new Set(['org-1']));
		expect(updates[0]).toEqual({ status: 'pending', current: undefined });
		expect(updates.at(-1)).toEqual({ status: 'done', current: 3 });
		expect(
			updates.filter((update) => update.status === 'running').length
		).toBeGreaterThanOrEqual(1);
	});

	test('handler failure: status failed, error sink capture, INTERNAL code', async () => {
		const { deps, capturedErrors } = createTestDeps();
		const store = createInMemoryTaskStore();
		const task = createTaskFactory({ deps, store });
		const instance = task({
			id: 'boom',
			input: t.Object({}),
			handler: async () => {
				throw new Error('secret detail');
			},
		});
		const { runId } = await instance.start(
			{},
			{ scope: {}, tenantId: 'org-9' }
		);
		const finished = await waitFor(
			() => instance.get(runId),
			(record) => record.status === 'failed'
		);
		expect(finished.error).toBe('INTERNAL');
		expect(capturedErrors).toHaveLength(1);
		expect(capturedErrors[0]?.context.entrypoint).toBe('task');
		expect(capturedErrors[0]?.context.tenantId).toBe('org-9');
	});

	test('cancel aborts a running handler', async () => {
		const { deps } = createTestDeps();
		const store = createInMemoryTaskStore();
		const task = createTaskFactory({ deps, store });
		let started: (() => void) | null = null;
		const startedGate = new Promise<void>((resolve) => {
			started = resolve;
		});
		const instance = task({
			id: 'cancellable',
			input: t.Object({}),
			handler: (ctx) =>
				new Promise((_resolve, reject) => {
					started?.();
					ctx.signal.addEventListener(
						'abort',
						() => reject(new Error('aborted')),
						{ once: true }
					);
				}),
		});
		const { runId } = await instance.start({}, { scope: {} });
		await startedGate;
		expect(instance.cancel(runId)).toBe(true);
		const finished = await waitFor(
			() => instance.get(runId),
			(record) => record.status === 'cancelled'
		);
		expect(finished.error).toBe('CANCELLED');
		// Already finished — nothing to cancel anymore.
		expect(instance.cancel(runId)).toBe(false);
	});

	test('timeout cancels the run', async () => {
		const { deps } = createTestDeps();
		const store = createInMemoryTaskStore();
		const task = createTaskFactory({
			deps,
			store,
			defaultTimeoutMs: 20,
		});
		const instance = task({
			id: 'hangs',
			input: t.Object({}),
			handler: (ctx) =>
				new Promise((_resolve, reject) => {
					ctx.signal.addEventListener(
						'abort',
						() => reject(new Error('aborted')),
						{ once: true }
					);
				}),
		});
		const { runId } = await instance.start({}, { scope: {} });
		const finished = await waitFor(
			() => instance.get(runId),
			(record) => record.status === 'cancelled'
		);
		expect(finished.status).toBe('cancelled');
	});

	test('onUpdate observer errors never break the run', async () => {
		const { deps } = createTestDeps();
		const store = createInMemoryTaskStore();
		const task = createTaskFactory({ deps, store });
		const instance = task({
			id: 'noisy-observer',
			input: t.Object({}),
			onUpdate: () => {
				throw new Error('observer bug');
			},
			handler: async () => 'fine',
		});
		const { runId } = await instance.start({}, { scope: {} });
		const finished = await waitFor(
			() => instance.get(runId),
			(record) => record.status === 'done'
		);
		expect(finished.result).toBe('fine');
	});
});
