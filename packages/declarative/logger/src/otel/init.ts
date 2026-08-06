/**
 * OpenTelemetry SDK Initialization
 *
 * Call initTracing() at the very start of your service, before any other imports.
 * This ensures all spans are properly captured.
 */

import {
	DiagConsoleLogger,
	DiagLogLevel,
	diag,
	trace,
} from '@opentelemetry/api';
import {
	type ExportResult,
	ExportResultCode,
	W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
	BatchSpanProcessor,
	NodeTracerProvider,
	ParentBasedSampler,
	type ReadableSpan,
	type SpanExporter,
	type SpanProcessor,
	TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';

/**
 * Telemetry must never take the service down: exporters can throw
 * synchronously out of runtime-specific transport internals (grpc-js on Bun's
 * node:http2 shim did exactly that), and an uncaught throw inside the batch
 * processor's timer is fatal to the process. This wrapper converts any such
 * throw into a failed ExportResult — spans are lost, the service is not.
 */
class SafeSpanExporter implements SpanExporter {
	constructor(private readonly inner: SpanExporter) {}

	export(
		spans: ReadableSpan[],
		resultCallback: (result: ExportResult) => void
	): void {
		try {
			this.inner.export(spans, resultCallback);
		} catch (error) {
			console.error('[OTEL] Span export threw — dropping batch', error);
			resultCallback({
				code: ExportResultCode.FAILED,
				error:
					error instanceof Error ? error : new Error(String(error)),
			});
		}
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown().catch((error) => {
			console.error('[OTEL] Span exporter shutdown failed', error);
		});
	}

	forceFlush(): Promise<void> {
		if (this.inner.forceFlush === undefined) return Promise.resolve();
		return this.inner.forceFlush().catch((error) => {
			console.error('[OTEL] Span exporter flush failed', error);
		});
	}
}

// Semantic convention attribute keys
// Using string literals for stability across package versions
const ATTR_SERVICE_NAME = 'service.name';
const ATTR_SERVICE_VERSION = 'service.version';
const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

let isInitialized = false;
let tracerProvider: NodeTracerProvider | null = null;

export interface TracingConfig {
	/** Service name for traces */
	serviceName: string;
	/** Service version (optional) */
	serviceVersion?: string;
	/** Environment (defaults to NODE_ENV) */
	environment?: string;
	/** OTLP endpoint (defaults to auto-detect Jaeger local or OTEL collector) */
	endpoint?: string;
	/** Sampling rate 0.0-1.0 (defaults to 1.0 in dev, 0.1 in prod) */
	sampleRate?: number;
	/** Enable debug logging for OTEL SDK */
	debug?: boolean;
	/**
	 * Transport protocol, default 'http'. 'grpc' is opt-in for Node runtimes
	 * only: grpc-js rides on node:http2, whose Bun shim throws at export time
	 * — on Bun that surfaces as an uncaught exception and kills the process.
	 */
	transport?: 'grpc' | 'http';
	/** HTTP headers for authentication (e.g., BetterStack token). Can also use OTEL_EXPORTER_OTLP_HEADERS env var */
	headers?: Record<string, string>;
}

/**
 * Get the OTLP exporter endpoint
 * Priority:
 * 1. Explicit endpoint parameter
 * 2. OTEL_EXPORTER_OTLP_ENDPOINT env var
 * 3. Auto-detect: localhost in dev, otel-collector in prod
 *
 * @param transport - 'grpc' uses port 4317, 'http' uses port 4318
 */
function getExporterEndpoint(
	explicitEndpoint?: string,
	transport: 'grpc' | 'http' = 'http'
): string {
	if (explicitEndpoint) {
		return normalizeEndpointPath(explicitEndpoint, transport);
	}

	if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
		return normalizeEndpointPath(
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			transport
		);
	}

	const port = transport === 'grpc' ? '4317' : '4318';
	const path = transport === 'http' ? '/v1/traces' : '';
	return buildDefaultEndpoint(port, path);
}

/**
 * The http exporter takes its `url` verbatim — a base endpoint like
 * `http://localhost:4318` (the common env value; the spec appends the signal
 * path only for env-var config) would 404 on every export. Append `/v1/traces`
 * when the URL carries no explicit path; endpoints that already name a path
 * (BetterStack ingest URLs) pass through untouched.
 */
function normalizeEndpointPath(
	endpoint: string,
	transport: 'grpc' | 'http'
): string {
	if (transport !== 'http') return endpoint;
	try {
		const url = new URL(endpoint);
		if (url.pathname === '/' || url.pathname === '') {
			url.pathname = '/v1/traces';
			return url.toString();
		}
		return endpoint;
	} catch {
		return endpoint;
	}
}

function buildDefaultEndpoint(port: string, path: string): string {
	// Default to local Jaeger in development (use 127.0.0.1 to avoid IPv6 issues)
	if (
		process.env.NODE_ENV === 'development' ||
		process.env.NODE_ENV === undefined
	) {
		const url = `http://127.0.0.1:${port}${path}`;
		return url;
	}

	// Production: OTEL collector
	return `http://otel-collector:${port}${path}`;
}

/**
 * Get sampling rate
 * Priority:
 * 1. Explicit sampleRate parameter
 * 2. OTEL_TRACES_SAMPLER_ARG env var
 * 3. Auto-detect: 1.0 in dev, 0.1 in prod
 */
function getSampleRate(explicitRate?: number): number {
	if (explicitRate !== undefined) {
		return Math.max(0, Math.min(1, explicitRate));
	}

	if (process.env.OTEL_TRACES_SAMPLER_ARG) {
		const rate = parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG);
		if (!isNaN(rate)) {
			return Math.max(0, Math.min(1, rate));
		}
	}

	// Default: 100% in development, 10% in production
	if (
		process.env.NODE_ENV === 'development' ||
		process.env.NODE_ENV === undefined
	) {
		return 1.0;
	}

	return 0.1;
}

/**
 * Parse OTEL headers from environment variable
 * Format: "key1=value1,key2=value2" or "key1=value1, key2=value2"
 * Standard env var: OTEL_EXPORTER_OTLP_HEADERS
 */
function parseHeadersFromEnv(): Record<string, string> {
	const headersEnv = process.env.OTEL_EXPORTER_OTLP_HEADERS;
	if (!headersEnv) {
		return {};
	}

	const headers: Record<string, string> = {};
	const pairs = headersEnv.split(',');

	for (const pair of pairs) {
		const [key, ...valueParts] = pair.split('=');
		if (key && valueParts.length > 0) {
			// Rejoin in case value contains '='
			headers[key.trim()] = valueParts.join('=').trim();
		}
	}

	return headers;
}

/**
 * Initialize OpenTelemetry tracing for a service
 *
 * Call this ONCE at the very start of your service entry point:
 * ```typescript
 * import { initTracing } from '@declarativejs/logger';
 * initTracing({ serviceName: 'command-service' });
 * // ... rest of imports and code
 * ```
 */
export function initTracing(config: TracingConfig): void {
	if (isInitialized) {
		console.warn('[OTEL] Tracing already initialized, skipping');
		return;
	}

	const {
		serviceName,
		serviceVersion = process.env.SERVICE_VERSION || '0.0.0',
		environment = process.env.NODE_ENV || 'development',
		endpoint,
		sampleRate,
		debug = false,
		headers,
	} = config;

	// http everywhere by default: works on Bun and Node alike (Jaeger and the
	// collector listen on 4318). grpc is explicit opt-in — see TracingConfig.
	const resolvedTransport = config.transport ?? 'http';

	// Enable debug logging if requested
	if (debug) {
		diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
	}

	const resolvedEndpoint = getExporterEndpoint(endpoint, resolvedTransport);
	const resolvedSampleRate = getSampleRate(sampleRate);

	// Parse headers from env var (format: "key1=value1,key2=value2")
	const resolvedHeaders = headers ?? parseHeadersFromEnv();

	console.log(`[OTEL] Initializing tracing for ${serviceName}`, {
		endpoint: resolvedEndpoint,
		transport: resolvedTransport,
		sampleRate: resolvedSampleRate,
		environment,
		hasHeaders: Object.keys(resolvedHeaders).length > 0,
	});

	// Create resource with service info
	const resource = new Resource({
		[ATTR_SERVICE_NAME]: serviceName,
		[ATTR_SERVICE_VERSION]: serviceVersion,
		[ATTR_DEPLOYMENT_ENVIRONMENT]: environment,
	});

	// Create sampler (parent-based with ratio for root spans)
	const sampler = new ParentBasedSampler({
		root: new TraceIdRatioBasedSampler(resolvedSampleRate),
	});

	// Create OTLP exporter based on transport
	const exporter =
		resolvedTransport === 'grpc'
			? new OTLPTraceExporterGrpc({ url: resolvedEndpoint })
			: new OTLPTraceExporterHttp({
					url: resolvedEndpoint,
					headers: resolvedHeaders,
				});

	// Create batch span processor for efficient exporting
	const spanProcessor: SpanProcessor = new BatchSpanProcessor(
		new SafeSpanExporter(exporter),
		{
			maxQueueSize: 2048,
			maxExportBatchSize: 512,
			scheduledDelayMillis: 5000,
			exportTimeoutMillis: 30000,
		}
	);

	// Create and register the tracer provider
	tracerProvider = new NodeTracerProvider({
		resource,
		sampler,
		spanProcessors: [spanProcessor],
	});

	// Register the tracer provider with W3C Trace Context propagator
	// This is REQUIRED for propagation.inject() and propagation.extract() to work
	tracerProvider.register({
		propagator: new W3CTraceContextPropagator(),
	});

	isInitialized = true;
	console.log(`[OTEL] Tracing initialized successfully for ${serviceName}`);
}

/**
 * Get a tracer for creating spans
 *
 * @param name - Tracer name (typically component name like 'kafka-producer')
 * @param version - Optional version
 */
export function getTracer(name: string, version?: string) {
	if (!isInitialized) {
		console.warn('[OTEL] Tracing not initialized, returning no-op tracer');
	}
	return trace.getTracer(name, version);
}

/**
 * Gracefully shutdown tracing (call on service shutdown)
 */
export async function shutdownTracing(): Promise<void> {
	if (tracerProvider) {
		console.log('[OTEL] Shutting down tracing...');
		await tracerProvider.shutdown();
		tracerProvider = null;
		isInitialized = false;
		console.log('[OTEL] Tracing shutdown complete');
	}
}

/**
 * Check if tracing is initialized
 */
export function isTracingInitialized(): boolean {
	return isInitialized;
}
