import type { Span, TracerPort } from './ports';

const NOOP_SPAN: Span = {
	setAttribute() {},
	recordError() {},
	setStatus() {},
	end() {},
	traceparent: '',
	traceId: '',
};

/**
 * A tracer that records nothing — the default when a composition root wires no
 * OpenTelemetry adapter (tests, or services with tracing disabled). Keeps the
 * factories tracer-unconditional: they always call `startSpan`, this makes it
 * free.
 */
export const noopTracer: TracerPort = {
	startSpan: () => NOOP_SPAN,
};
