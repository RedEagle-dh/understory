import { describe, expect, test } from 'bun:test';
import { Type as t } from '@sinclair/typebox';
import {
	type ConsumerContext,
	createConsumerFactory,
	defineConsumerStage,
} from '../consumer';
import { TypedError } from '../errors';
import { halt, pipeline, provide } from '../pipeline';
import { createTestDeps } from '../testing';

interface Tenant {
	readonly tenantId: string;
}

const tenancy = defineConsumerStage<object, object, Tenant>(
	'tenancy',
	async (_decl, ctx) => {
		const tenantId = ctx.subject.split('.')[1];
		if (tenantId === undefined || tenantId === 'unknown')
			return halt(403, 'TENANT_UNRESOLVED');
		return provide({ tenantId });
	}
);

class EventRejectedError extends TypedError {
	readonly code = 'EVENT_REJECTED';
	readonly status = 422;
}

const ModActionEvent = t.Object({ action: t.String(), targetId: t.String() });

function setup(options?: { failTimes?: number; slow?: boolean }) {
	const testDeps = createTestDeps();
	const consumer = createConsumerFactory({
		pipeline: pipeline<ConsumerContext>().use(tenancy),
		deps: testDeps.deps,
		idempotencyStore: testDeps.idempotencyStore,
		defaultTimeoutMs: 100,
	});

	const processed: Array<{ tenantId: string; action: string }> = [];
	let failures = options?.failTimes ?? 0;

	const onModAction = consumer({
		id: 'moderation.onModAction',
		subject: 'events.*.moderation.action',
		event: ModActionEvent,
		errors: [EventRejectedError],
		retry: { attempts: 3, minDelayMs: 100, maxDelayMs: 1_000 },
		idempotent: true,
		handler: async (ctx) => {
			if (options?.slow === true)
				await new Promise((resolve) => setTimeout(resolve, 300));
			if (failures > 0) {
				failures -= 1;
				throw new Error('transient db hiccup');
			}
			if (ctx.event.action === 'reject-me')
				throw new EventRejectedError('business said no');
			processed.push({
				tenantId: ctx.tenantId,
				action: ctx.event.action,
			});
		},
	});

	return { onModAction, processed, ...testDeps };
}

const message = (
	overrides?: Partial<
		Parameters<ReturnType<typeof setup>['onModAction']['handle']>[0]
	>
) => ({
	subject: 'events.org-1.moderation.action',
	payload: { action: 'ban', targetId: 'troll-9' },
	eventId: 'evt-1',
	attempt: 1,
	...overrides,
});

describe('consumer factory', () => {
	test('acks after pipeline, schema parsing and handler succeed', async () => {
		const { onModAction, processed } = setup();
		const outcome = await onModAction.handle(message());

		expect(outcome).toEqual({ kind: 'ack' });
		expect(processed).toEqual([{ tenantId: 'org-1', action: 'ban' }]);
	});

	test('duplicate delivery is skipped and acked', async () => {
		const { onModAction, processed, counters } = setup();
		await onModAction.handle(message());
		const outcome = await onModAction.handle(message());

		expect(outcome).toEqual({ kind: 'ack' });
		expect(processed).toHaveLength(1);
		expect(
			counters.some(
				(c) =>
					c.name === 'events_processed_total' &&
					c.labels?.result === 'duplicate'
			)
		).toBe(true);
	});

	test('poison message (schema mismatch) goes to the dead letter queue, not retry', async () => {
		const { onModAction } = setup();
		const outcome = await onModAction.handle(
			message({ payload: { nope: true } })
		);

		expect(outcome.kind).toBe('deadLetter');
	});

	test('pipeline halt is deterministic: dead letter with stage and code', async () => {
		const { onModAction } = setup();
		const outcome = await onModAction.handle(
			message({ subject: 'events.unknown.moderation.action' })
		);

		expect(outcome).toEqual({
			kind: 'deadLetter',
			reason: 'tenancy:TENANT_UNRESOLVED',
		});
	});

	test('declared TypedError is a business rejection: dead letter without error sink', async () => {
		const { onModAction, capturedErrors } = setup();
		const outcome = await onModAction.handle(
			message({ payload: { action: 'reject-me', targetId: 'x' } })
		);

		expect(outcome).toEqual({
			kind: 'deadLetter',
			reason: 'EVENT_REJECTED',
		});
		expect(capturedErrors).toHaveLength(0);
	});

	test('unknown error retries with exponential backoff and does not hit the sink early', async () => {
		const { onModAction, capturedErrors } = setup({ failTimes: 99 });
		const first = await onModAction.handle(message({ attempt: 1 }));
		const second = await onModAction.handle(message({ attempt: 2 }));

		expect(first).toEqual({ kind: 'retry', delayMs: 100 });
		expect(second).toEqual({ kind: 'retry', delayMs: 200 });
		expect(capturedErrors).toHaveLength(0);
	});

	test('exhausted attempts dead-letter and capture the error exactly once', async () => {
		const { onModAction, capturedErrors } = setup({ failTimes: 99 });
		const outcome = await onModAction.handle(message({ attempt: 3 }));

		expect(outcome).toEqual({ kind: 'deadLetter', reason: 'UNHANDLED' });
		expect(capturedErrors).toHaveLength(1);
		expect(capturedErrors[0]?.context.entrypoint).toBe('consumer');
	});

	test('timeout is transient: retry without error sink', async () => {
		const { onModAction, capturedErrors } = setup({ slow: true });
		const outcome = await onModAction.handle(message());

		expect(outcome).toEqual({ kind: 'retry', delayMs: 100 });
		expect(capturedErrors).toHaveLength(0);
	});

	test('successful processing marks the event as seen only after the handler ran', async () => {
		const { onModAction, seenEventIds } = setup({ failTimes: 1 });
		await onModAction.handle(message({ attempt: 1 }));
		expect(seenEventIds.size).toBe(0);

		await onModAction.handle(message({ attempt: 2 }));
		expect(seenEventIds.has('moderation.onModAction:evt-1')).toBe(true);
	});

	test('declaring idempotent without a store fails fast at creation', () => {
		const { deps } = createTestDeps();
		const consumer = createConsumerFactory({
			pipeline: pipeline<ConsumerContext>(),
			deps,
		});

		expect(() =>
			consumer({
				id: 'broken',
				subject: 'events.x',
				event: ModActionEvent,
				idempotent: true,
				handler: async () => {},
			})
		).toThrow('IdempotencyStorePort');
	});
});
