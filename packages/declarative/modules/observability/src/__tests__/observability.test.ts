import { consoleLogger } from '@declarativejs/core/app';
import { describe, expect, it } from 'bun:test';
import { observabilityModule } from '../index';

describe('observabilityModule', () => {
	it('provides tracer + metrics without an OTLP endpoint (spans are no-ops)', () => {
		const obs = observabilityModule({ serviceName: 'test-svc' });
		const ports = obs.init({ log: consoleLogger });

		expect(ports.tracer).toBeDefined();
		expect(ports.metrics).toBeDefined();

		const { tracer, metrics } = ports;
		if (tracer !== undefined) tracer.startSpan('probe').end();
		if (metrics !== undefined) {
			metrics.increment('http_requests_total', { status: '2xx' });
			metrics.observe('http_request_duration_ms', 12.5, { route: 'r' });
		}
		expect(obs.metrics()).not.toBeNull();
	});

	it('exposes Prometheus exposition text with recorded metrics', async () => {
		const obs = observabilityModule({ serviceName: 'test-svc-2' });
		const ports = obs.init({ log: consoleLogger });
		const { metrics } = ports;
		if (metrics !== undefined) metrics.increment('widgets_total', { kind: 'a' });

		const prom = obs.metrics();
		expect(prom).not.toBeNull();
		if (prom !== null) {
			const text = await prom.metricsText();
			expect(text).toContain('widgets_total');
		}
	});
});
