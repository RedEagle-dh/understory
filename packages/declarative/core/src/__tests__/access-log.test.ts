import { describe, expect, test } from 'bun:test';
import { createPublishingAccessLog } from '../access-log';
import type { AccessLogEntry, EventPublisherPort } from '../ports';
import { createTestDeps } from '../testing';

function entry(requestId: string): AccessLogEntry {
	return {
		routeId: 'things.list',
		surface: 'internal',
		method: 'GET',
		status: 200,
		durationMs: 1,
		requestId,
		occurredAt: '2026-01-01T00:00:00.000Z',
	};
}

interface Published {
	readonly subject: string;
	readonly payload: unknown;
}

function recordingPublisher(sink: Published[]): EventPublisherPort {
	return {
		publish: async (subject, payload) => {
			sink.push({ subject, payload });
		},
	};
}

describe('publishing access log', () => {
	test('buffers entries until bind, then flushes in order and publishes live', async () => {
		const { deps } = createTestDeps();
		const published: Published[] = [];
		const accessLog = createPublishingAccessLog({
			log: deps.log,
			subject: 'telemetry.access.v1',
		});

		accessLog.port.record(entry('req-1'));
		accessLog.port.record(entry('req-2'));
		expect(published).toHaveLength(0);

		accessLog.bind(recordingPublisher(published));
		accessLog.port.record(entry('req-3'));
		await Bun.sleep(0);

		expect(published.map((p) => p.subject)).toEqual([
			'telemetry.access.v1',
			'telemetry.access.v1',
			'telemetry.access.v1',
		]);
		expect(
			published.map((p) =>
				typeof p.payload === 'object' &&
				p.payload !== null &&
				'requestId' in p.payload
					? p.payload.requestId
					: undefined
			)
		).toEqual(['req-1', 'req-2', 'req-3']);
	});

	test('drops the oldest entries beyond the buffer cap and reports the loss on bind', async () => {
		const { deps, logs } = createTestDeps();
		const published: Published[] = [];
		const accessLog = createPublishingAccessLog({
			log: deps.log,
			subject: 'telemetry.access.v1',
			maxBuffer: 2,
		});

		accessLog.port.record(entry('req-1'));
		accessLog.port.record(entry('req-2'));
		accessLog.port.record(entry('req-3'));
		accessLog.bind(recordingPublisher(published));
		await Bun.sleep(0);

		expect(published).toHaveLength(2);
		expect(
			logs.some((l) => l.level === 'warn' && l.fields?.['dropped'] === 1)
		).toBe(true);
	});

	test('a failing publish is logged and never throws into the caller', async () => {
		const { deps, logs } = createTestDeps();
		const accessLog = createPublishingAccessLog({
			log: deps.log,
			subject: 'telemetry.access.v1',
		});
		accessLog.bind({
			publish: async () => {
				throw new Error('broker down');
			},
		});

		expect(() => accessLog.port.record(entry('req-1'))).not.toThrow();
		await Bun.sleep(0);

		expect(
			logs.some(
				(l) =>
					l.level === 'warn' &&
					l.message === 'access log publish failed' &&
					l.fields?.['error'] === 'broker down'
			)
		).toBe(true);
	});
});
