import type { TraceContext } from '../propagation/types';
import { getOtelApi, hasOtel } from './detector';

/**
 * Extract trace context from active OTEL span
 * Returns null if OTEL is not available or no active span
 */
export function getActiveTraceContext(): TraceContext | null {
	if (!hasOtel()) return null;

	const api = getOtelApi();
	if (!api) return null;

	const activeSpan = api.trace.getActiveSpan();
	if (!activeSpan) return null;

	const spanContext = activeSpan.spanContext();

	// Check for invalid/empty trace context
	if (spanContext.traceId === '00000000000000000000000000000000') {
		return null;
	}

	const sampled = (spanContext.traceFlags & api.TraceFlags.SAMPLED) !== 0;

	return {
		traceId: spanContext.traceId,
		spanId: spanContext.spanId,
		sampled,
		traceparent: formatTraceparent(spanContext, sampled),
	};
}

/**
 * Format a traceparent header from span context
 */
function formatTraceparent(
	spanContext: { traceId: string; spanId: string },
	sampled: boolean
): string {
	const version = '00';
	const flags = sampled ? '01' : '00';
	return `${version}-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}
