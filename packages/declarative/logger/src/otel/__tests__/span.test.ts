import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { createSpanTracer } from '../span';

/**
 * Verifies the OTEL span adapter that binds onto the framework TracerPort
 * (ADR-0009): parent/remote-parent linkage, attributes, and status/error
 * mapping, all against an in-memory exporter (no collector needed). The tracer
 * provider is process-global, so it is registered once and the exporter reset
 * between tests.
 */
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register({ propagator: new W3CTraceContextPropagator() });

beforeEach(() => exporter.reset());
afterAll(async () => provider.shutdown());

const INBOUND = '00-1234567890abcdef1234567890abcdef-abcdef1234567890-01';
const INBOUND_TRACE = '1234567890abcdef1234567890abcdef';

describe('createSpanTracer', () => {
	test('nests spans and continues an inbound remote trace', () => {
		const tracer = createSpanTracer('span-test');

		const root = tracer.startSpan('GET things.list', {
			remoteParent: INBOUND,
			attributes: { 'route.id': 'things.list' },
		});
		const child = tracer.startSpan('stage.authn', { parent: root });
		child.setStatus('ok');
		child.end();
		root.setAttribute('http.status_code', 200);
		root.setStatus('ok');
		root.end();

		const spans = exporter.getFinishedSpans();
		const rootSpan = spans.find((s) => s.name === 'GET things.list');
		const childSpan = spans.find((s) => s.name === 'stage.authn');

		expect(rootSpan?.spanContext().traceId).toBe(INBOUND_TRACE);
		expect(rootSpan?.parentSpanId).toBe('abcdef1234567890');
		expect(rootSpan?.attributes['route.id']).toBe('things.list');
		expect(rootSpan?.attributes['http.status_code']).toBe(200);
		expect(childSpan?.spanContext().traceId).toBe(INBOUND_TRACE);
		expect(childSpan?.parentSpanId).toBe(rootSpan?.spanContext().spanId);
		// The port's traceparent/traceId getters expose the live context.
		expect(root.traceId).toBe(INBOUND_TRACE);
		expect(root.traceparent).toMatch(
			/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/
		);
	});

	test('recordError marks the span failed and attaches an exception event', () => {
		const tracer = createSpanTracer('span-test');

		const span = tracer.startSpan('stage.policy');
		span.recordError(new Error('kaboom'));
		span.end();

		const [recorded] = exporter.getFinishedSpans();
		// OTEL SpanStatusCode.ERROR === 2.
		expect(recorded?.status.code).toBe(2);
		expect(recorded?.events.length ?? 0).toBeGreaterThanOrEqual(1);
	});
});
