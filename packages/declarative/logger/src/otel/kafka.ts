/**
 * Kafka Tracing Utilities
 *
 * Provides trace context injection/extraction for Kafka messages
 * following W3C Trace Context specification.
 */

import {
	type Context,
	context,
	propagation,
	ROOT_CONTEXT,
	type Span,
	SpanKind,
	SpanStatusCode,
	trace,
} from '@opentelemetry/api';
import type { TraceContext } from '../propagation/types';
import {
	formatTraceparent,
	parseTraceparent,
} from '../propagation/w3c-trace-context';

/**
 * Kafka message headers type (compatible with kafkajs)
 */
export type KafkaHeaders = Record<
	string,
	string | Buffer | (string | Buffer)[] | undefined
>;

/**
 * Carrier interface for W3C propagation
 */
interface HeaderCarrier {
	traceparent?: string;
	tracestate?: string;
}

/**
 * Extract trace context from Kafka message headers
 *
 * @param headers - Kafka message headers
 * @returns OpenTelemetry Context or ROOT_CONTEXT if no trace context found
 */
export function extractTraceContextFromKafka(headers?: KafkaHeaders): Context {
	if (!headers) {
		return ROOT_CONTEXT;
	}

	// Convert Kafka headers to carrier format
	const carrier: HeaderCarrier = {};

	const traceparent = headers['traceparent'];
	if (traceparent) {
		carrier.traceparent = Buffer.isBuffer(traceparent)
			? traceparent.toString('utf-8')
			: Array.isArray(traceparent)
				? traceparent[0]?.toString()
				: traceparent;
	}

	const tracestate = headers['tracestate'];
	if (tracestate) {
		carrier.tracestate = Buffer.isBuffer(tracestate)
			? tracestate.toString('utf-8')
			: Array.isArray(tracestate)
				? tracestate[0]?.toString()
				: tracestate;
	}

	// Use W3C trace context propagator to extract
	return propagation.extract(ROOT_CONTEXT, carrier);
}

/**
 * Inject trace context into Kafka message headers
 *
 * @param headers - Existing headers to add trace context to (mutated)
 * @param ctx - Optional context to inject (defaults to active context)
 * @returns The headers object with trace context added
 */
export function injectTraceContextToKafka(
	headers: KafkaHeaders = {},
	ctx?: Context
): KafkaHeaders {
	const carrier: HeaderCarrier = {};

	// Inject from active context or provided context
	propagation.inject(ctx ?? context.active(), carrier);

	if (carrier.traceparent) {
		headers['traceparent'] = carrier.traceparent;
	}
	if (carrier.tracestate) {
		headers['tracestate'] = carrier.tracestate;
	}

	return headers;
}

/**
 * Get traceparent string from current context
 * Useful for including in message payloads (e.g., domain events)
 */
export function getCurrentTraceparent(): string | undefined {
	const span = trace.getActiveSpan();
	if (!span) return undefined;

	const spanCtx = span.spanContext();
	if (spanCtx.traceId === '00000000000000000000000000000000') {
		return undefined;
	}

	const sampled = (spanCtx.traceFlags & 1) !== 0;
	return formatTraceparent({
		traceId: spanCtx.traceId,
		spanId: spanCtx.spanId,
		sampled,
	});
}

/**
 * Create a PRODUCER span for Kafka message production
 *
 * @param topic - Kafka topic name
 * @param operation - Operation description (e.g., 'send command')
 * @returns Span and context to use for the operation
 */
export function startProducerSpan(
	topic: string,
	operation: string
): { span: Span; ctx: Context } {
	const tracer = trace.getTracer('kafka-producer');

	const span = tracer.startSpan(
		`${topic} ${operation}`,
		{
			kind: SpanKind.PRODUCER,
			attributes: {
				'messaging.system': 'kafka',
				'messaging.destination': topic,
				'messaging.destination_kind': 'topic',
				'messaging.operation': 'publish',
			},
		},
		context.active()
	);

	const ctx = trace.setSpan(context.active(), span);

	return { span, ctx };
}

/**
 * Create a CONSUMER span for Kafka message consumption
 *
 * @param topic - Kafka topic name
 * @param partition - Kafka partition
 * @param offset - Message offset
 * @param parentHeaders - Headers from the consumed message (for linking)
 * @returns Span and context to use for processing
 */
export function startConsumerSpan(
	topic: string,
	partition: number,
	offset: string,
	parentHeaders?: KafkaHeaders
): { span: Span; ctx: Context } {
	const tracer = trace.getTracer('kafka-consumer');

	// Extract parent context from message headers
	const parentContext = extractTraceContextFromKafka(parentHeaders);

	const span = tracer.startSpan(
		`${topic} process`,
		{
			kind: SpanKind.CONSUMER,
			attributes: {
				'messaging.system': 'kafka',
				'messaging.source': topic,
				'messaging.destination_kind': 'topic',
				'messaging.operation': 'process',
				'messaging.kafka.partition': partition,
				'messaging.kafka.message_offset': offset,
			},
		},
		parentContext // Link to producer span via extracted context
	);

	const ctx = trace.setSpan(parentContext, span);

	return { span, ctx };
}

/**
 * Add command-specific attributes to a span
 */
export function addCommandAttributes(
	span: Span,
	commandType: string,
	commandId: string,
	aggregateId?: string
): void {
	span.setAttributes({
		'modlog.command.type': commandType,
		'modlog.command.id': commandId,
	});
	if (aggregateId) {
		span.setAttribute('modlog.aggregate.id', aggregateId);
	}
}

/**
 * Add event-specific attributes to a span
 */
export function addEventAttributes(
	span: Span,
	eventType: string,
	eventId: string,
	aggregateId?: string
): void {
	span.setAttributes({
		'modlog.event.type': eventType,
		'modlog.event.id': eventId,
	});
	if (aggregateId) {
		span.setAttribute('modlog.aggregate.id', aggregateId);
	}
}

/**
 * Record an error on a span
 */
export function recordSpanError(span: Span, error: Error | unknown): void {
	const err = error instanceof Error ? error : new Error(String(error));
	span.recordException(err);
	span.setStatus({
		code: SpanStatusCode.ERROR,
		message: err.message,
	});
}

/**
 * End a span successfully
 */
export function endSpanSuccess(span: Span): void {
	span.setStatus({ code: SpanStatusCode.OK });
	span.end();
}

/**
 * Wrapper to run async code within a span context
 */
export async function withKafkaSpan<T>(
	spanName: string,
	kind: SpanKind,
	attributes: Record<string, string | number | boolean>,
	fn: (span: Span) => Promise<T>,
	parentContext?: Context
): Promise<T> {
	const tracer = trace.getTracer('kafka');
	const span = tracer.startSpan(
		spanName,
		{ kind, attributes },
		parentContext ?? context.active()
	);

	const ctx = trace.setSpan(parentContext ?? context.active(), span);

	try {
		const result = await context.with(ctx, () => fn(span));
		span.setStatus({ code: SpanStatusCode.OK });
		return result;
	} catch (error) {
		recordSpanError(span, error);
		throw error;
	} finally {
		span.end();
	}
}

/**
 * Parse traceparent from various sources (headers or payload)
 * Returns TraceContext or null
 */
export function parseTraceContext(
	traceparent: string | undefined
): TraceContext | null {
	if (!traceparent) return null;

	const result = parseTraceparent(traceparent);
	return result.success ? result.context : null;
}
