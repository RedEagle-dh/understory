/**
 * W3C Trace Context representation
 * @see https://www.w3.org/TR/trace-context/
 */
export interface TraceContext {
	/** 32-character hex trace ID */
	traceId: string;
	/** 16-character hex span/parent ID */
	spanId: string;
	/** Sampling flag (true = sampled) */
	sampled: boolean;
	/** Original traceparent header value */
	traceparent?: string;
	/** Optional tracestate header value */
	tracestate?: string;
}

/**
 * Headers that can be used for trace propagation
 */
export interface PropagationHeaders {
	traceparent?: string;
	tracestate?: string;
	'x-request-id'?: string;
	'x-correlation-id'?: string;
	[key: string]: string | undefined;
}

/**
 * Result of trace context extraction
 */
export type TraceContextResult =
	| { success: true; context: TraceContext }
	| { success: false; error: string };
