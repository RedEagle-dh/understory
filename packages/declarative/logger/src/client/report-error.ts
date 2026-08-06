/**
 * Lightweight client-side error reporter
 * NO Pino dependency - this file must be tree-shakeable for browser bundles
 */

export interface ClientLogPayload {
	level: 'error' | 'warn';
	message: string;
	error?: { name: string; message: string; stack?: string };
	/** Server trace ID for correlation with server logs */
	traceId?: string;
	url: string;
	userAgent: string;
	timestamp: string;
	context?: Record<string, unknown>;
}

export interface ReportErrorOptions {
	/** Server trace ID from error response for correlation */
	traceId?: string;
	/** Additional context */
	context?: Record<string, unknown>;
}

/**
 * Report an error to the server
 * Fire-and-forget - does not block UI
 */
export async function reportError(
	message: string,
	error?: Error | unknown,
	options?: ReportErrorOptions
): Promise<void> {
	// Extract traceId from error if it's an API error with traceId
	const traceId = options?.traceId || extractTraceId(error);

	const payload: ClientLogPayload = {
		level: 'error',
		message,
		error: normalizeError(error),
		traceId,
		url: typeof window !== 'undefined' ? window.location.href : '',
		userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
		timestamp: new Date().toISOString(),
		context: options?.context,
	};

	// Fire and forget - don't block UI
	fetch('/api/log', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	}).catch(() => {
		// Silently fail - don't crash client for logging
	});
}

/**
 * Report a warning to the server
 */
export async function reportWarning(
	message: string,
	options?: ReportErrorOptions
): Promise<void> {
	const payload: ClientLogPayload = {
		level: 'warn',
		message,
		traceId: options?.traceId,
		url: typeof window !== 'undefined' ? window.location.href : '',
		userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
		timestamp: new Date().toISOString(),
		context: options?.context,
	};

	fetch('/api/log', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	}).catch(() => {});
}

/**
 * Normalize unknown error to structured format
 */
function normalizeError(error: unknown): ClientLogPayload['error'] | undefined {
	if (!error) return undefined;

	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}

	if (typeof error === 'object' && 'message' in error) {
		const e = error as Record<string, unknown>;
		return {
			name: String(e.name || 'Error'),
			message: String(e.message),
			stack: e.stack ? String(e.stack) : undefined,
		};
	}

	return {
		name: 'Error',
		message: String(error),
	};
}

/**
 * Extract traceId from API error responses
 * Checks common patterns for trace ID in error objects
 */
function extractTraceId(error: unknown): string | undefined {
	if (!error || typeof error !== 'object') return undefined;

	const e = error as Record<string, unknown>;

	// Direct properties
	if (typeof e.traceId === 'string') return e.traceId;
	if (typeof e.trace_id === 'string') return e.trace_id;

	// Nested in data (common API pattern)
	if (e.data && typeof e.data === 'object') {
		const data = e.data as Record<string, unknown>;
		if (typeof data.traceId === 'string') return data.traceId;
		if (typeof data.trace_id === 'string') return data.trace_id;
	}

	// Nested in response (axios-style)
	if (e.response && typeof e.response === 'object') {
		const response = e.response as Record<string, unknown>;
		if (typeof response.traceId === 'string') return response.traceId;
		if (typeof response.trace_id === 'string') return response.trace_id;
	}

	return undefined;
}
