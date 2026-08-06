import type { MetricsPort } from '@declarativejs/core';
import { Counter, Histogram, Registry } from 'prom-client';

export interface PromMetrics {
	readonly port: MetricsPort;
	readonly registry: Registry;
	/** Prometheus exposition text — serve it from a `/metrics` route. */
	metricsText(): Promise<string>;
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * A Prometheus-backed MetricsPort. Metrics are created lazily on first use with
 * the label names of that first call (prom-client requires a fixed label set
 * per metric — the framework uses a consistent set per metric name).
 */
export function createPromMetrics(): PromMetrics {
	const registry = new Registry();
	const counters = new Map<string, Counter<string>>();
	const histograms = new Map<string, Histogram<string>>();

	const port: MetricsPort = {
		increment(name, labels) {
			const key = sanitize(name);
			let counter = counters.get(key);
			if (counter === undefined) {
				counter = new Counter({
					name: key,
					help: name,
					labelNames: Object.keys(labels ?? {}),
					registers: [registry],
				});
				counters.set(key, counter);
			}
			counter.inc(labels ?? {});
		},
		observe(name, valueMs, labels) {
			const key = sanitize(name);
			let histogram = histograms.get(key);
			if (histogram === undefined) {
				histogram = new Histogram({
					name: key,
					help: name,
					labelNames: Object.keys(labels ?? {}),
					registers: [registry],
				});
				histograms.set(key, histogram);
			}
			histogram.observe(labels ?? {}, valueMs);
		},
	};

	return {
		port,
		registry,
		metricsText: () => registry.metrics(),
	};
}
