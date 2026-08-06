import type {
	PropagationHeaders,
	TraceContext,
	TraceContextResult,
} from './types';

/**
 * W3C Trace Context Parser/Generator
 * Implements https://www.w3.org/TR/trace-context/
 */

const TRACEPARENT_REGEX =
	/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Parse a W3C traceparent header
 */
export function parseTraceparent(header: string): TraceContextResult {
	const trimmed = header.trim().toLowerCase();
	const match = trimmed.match(TRACEPARENT_REGEX);

	if (!match) {
		return {
			success: false,
			error: `Invalid traceparent format: ${header}`,
		};
	}

	const [, version, traceId, spanId, flags] = match as [
		string,
		string,
		string,
		string,
		string,
	];

	// Version ff is invalid
	if (version === 'ff') {
		return {
			success: false,
			error: 'Invalid traceparent version: ff',
		};
	}

	// Invalid if trace ID is all zeros
	if (traceId === '00000000000000000000000000000000') {
		return {
			success: false,
			error: 'Trace ID cannot be all zeros',
		};
	}

	// Invalid if span ID is all zeros
	if (spanId === '0000000000000000') {
		return {
			success: false,
			error: 'Span ID cannot be all zeros',
		};
	}

	return {
		success: true,
		context: {
			traceId,
			spanId,
			sampled: (parseInt(flags, 16) & 0x01) !== 0,
			traceparent: trimmed,
		},
	};
}

/**
 * Generate a W3C traceparent header
 */
export function formatTraceparent(context: TraceContext): string {
	const version = '00';
	const flags = context.sampled ? '01' : '00';
	return `${version}-${context.traceId}-${context.spanId}-${flags}`;
}

/**
 * Generate a new random trace ID (32 hex chars)
 */
export function generateTraceId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Generate a new random span ID (16 hex chars)
 */
export function generateSpanId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Create a new trace context with fresh IDs
 */
export function createTraceContext(sampled = true): TraceContext {
	const traceId = generateTraceId();
	const spanId = generateSpanId();
	return {
		traceId,
		spanId,
		sampled,
		traceparent: `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`,
	};
}

/**
 * Extract trace context from HTTP headers
 * Tries W3C traceparent first, falls back to x-request-id
 */
export function extractFromHeaders(
	headers: PropagationHeaders | Record<string, string | string[] | undefined>
): TraceContext | null {
	const normalized = normalizeHeaders(headers);

	// Try W3C traceparent first
	if (normalized.traceparent) {
		const result = parseTraceparent(normalized.traceparent);
		if (result.success) {
			return {
				...result.context,
				tracestate: normalized.tracestate,
			};
		}
	}

	// Fallback: Use x-request-id or x-correlation-id as trace ID
	const fallbackId =
		normalized['x-request-id'] || normalized['x-correlation-id'];
	if (fallbackId) {
		const traceId = normalizeToTraceId(fallbackId);
		return {
			traceId,
			spanId: generateSpanId(),
			sampled: true,
		};
	}

	return null;
}

/**
 * Inject trace context into outgoing HTTP headers
 */
export function injectToHeaders(
	context: TraceContext | null
): PropagationHeaders {
	if (!context) return {};

	const headers: PropagationHeaders = {
		traceparent: context.traceparent || formatTraceparent(context),
	};

	if (context.tracestate) {
		headers.tracestate = context.tracestate;
	}

	return headers;
}

/**
 * Normalize headers to lowercase keys
 */
function normalizeHeaders(
	headers: Record<string, string | string[] | undefined>
): Record<string, string | undefined> {
	const normalized: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(headers)) {
		normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
	}
	return normalized;
}

/**
 * Normalize an ID string to 32-char hex trace ID format
 */
function normalizeToTraceId(id: string): string {
	// If already 32 hex chars, use as-is
	if (/^[0-9a-f]{32}$/i.test(id)) {
		return id.toLowerCase();
	}

	// Pad the ID to fill 32 chars (left-pad with zeros)
	const cleaned = id.replace(/[^0-9a-f]/gi, '').toLowerCase();
	if (cleaned.length >= 32) {
		return cleaned.slice(0, 32);
	}
	return cleaned.padStart(32, '0');
}
