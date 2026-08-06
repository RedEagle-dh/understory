import type { AccessLogPort } from '@declarativejs/core';
import type {
	ObservabilityPorts,
	TelemetryProvider,
} from '@declarativejs/core/app';
import {
	createSpanTracer,
	initTracing,
	isTracingInitialized,
	shutdownTracing,
} from '@declarativejs/logger';
import { createPromMetrics, type PromMetrics } from './metrics';

export interface ObservabilityOptions {
	readonly serviceName: string;
	readonly environment?: string;
	/**
	 * OTLP endpoint. When omitted, the OTEL SDK is not initialized and the tracer
	 * opens no-op spans — tracing is "on" (spans exist) but exports nowhere.
	 */
	readonly otelEndpoint?: string;
	/**
	 * An access-log sink to surface through the access-log port (e.g. the
	 * ClickHouse sink from @declarativejs/module-access-log). Optional.
	 */
	readonly accessLog?: AccessLogPort;
}

/**
 * The optional observability module (ADR-0009): OpenTelemetry tracing via
 * @declarativejs/logger (Bun-safe http exporter) + Prometheus metrics. Exposes
 * the metrics registry on the returned value so the app can serve `/metrics`.
 *
 * When this package is not installed the generated manifest omits it entirely
 * and the core falls back to no-op telemetry — nothing hard-imports it.
 */
export interface ObservabilityInstance extends TelemetryProvider {
	/** The Prometheus registry, for a `/metrics` endpoint. Populated after `init`. */
	metrics(): PromMetrics | null;
}

export function observabilityModule(
	options: ObservabilityOptions
): ObservabilityInstance {
	let prom: PromMetrics | null = null;

	return {
		id: 'observability',
		metrics: () => prom,
		init: ({ log }) => {
			if (options.otelEndpoint !== undefined && !isTracingInitialized()) {
				initTracing({
					serviceName: options.serviceName,
					environment: options.environment,
					endpoint: options.otelEndpoint,
				});
				log.info('observability: OTEL tracing initialized', {
					endpoint: options.otelEndpoint,
				});
			}
			prom = createPromMetrics();
			const ports: ObservabilityPorts = {
				tracer: createSpanTracer(options.serviceName),
				metrics: prom.port,
				...(options.accessLog !== undefined
					? { accessLog: options.accessLog }
					: {}),
			};
			return ports;
		},
		drain: {
			dispose: async () => {
				if (options.otelEndpoint !== undefined) await shutdownTracing();
			},
		},
	};
}

export { createPromMetrics } from './metrics';
export type { PromMetrics } from './metrics';
