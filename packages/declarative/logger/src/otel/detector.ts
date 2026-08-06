/**
 * Detects if OpenTelemetry API is available and properly initialized
 * Uses dynamic import to handle optional dependency
 */

let otelApi: typeof import('@opentelemetry/api') | null = null;
let detectionComplete = false;
let otelAvailable = false;

/**
 * Detect if OTEL is available and initialized
 * This is async because it uses dynamic import for tree-shaking
 */
export async function detectOtel(): Promise<boolean> {
	return false;

	// biome-ignore lint/correctness/noUnreachable: deliberate kill-switch — detection short-circuits to false pending OTEL-on-Bun rework (the grpc exporter crashes Bun). The block below is retained on purpose as documentation of the intended detection.
	if (detectionComplete) return otelAvailable;

	try {
		// Dynamic import for tree-shaking
		const loadedApi = await import('@opentelemetry/api');
		otelApi = loadedApi;

		// Check if OTEL is actually initialized (not just imported)
		// A valid trace provider should be registered
		const tracer = loadedApi.trace.getTracer('otel-detector');
		const testSpan = tracer.startSpan('detection-test');
		const spanContext = testSpan.spanContext();

		// If traceId is all zeros, OTEL is not properly initialized
		otelAvailable =
			spanContext.traceId !== '00000000000000000000000000000000';

		testSpan.end();
	} catch {
		otelAvailable = false;
	}

	detectionComplete = true;
	return otelAvailable;
}

/**
 * Synchronous check if OTEL is available (returns cached result)
 * Returns false if detection hasn't completed yet
 */
export function hasOtel(): boolean {
	return detectionComplete && otelAvailable;
}

/**
 * Check if OTEL detection has been completed
 */
export function isOtelDetectionComplete(): boolean {
	return detectionComplete;
}

/**
 * Get the OTEL API module if available
 * Returns null if OTEL is not available or not initialized
 */
export function getOtelApi(): typeof import('@opentelemetry/api') | null {
	return otelAvailable ? otelApi : null;
}
