import {
	type Span as OtelSpan,
	context as otelContext,
	SpanStatusCode,
	trace,
} from '@opentelemetry/api';
import { parseTraceparent } from '../propagation/w3c-trace-context';
import { getTracer } from './init';

/**
 * A minimal span the rest of the codebase programs against without importing
 * `@opentelemetry/api` directly. Shape matches `@declarativejs/core`'s `Span`
 * port structurally, so `createSpanTracer()` binds straight onto its
 * `TracerPort` (ADR-0009) — this package stays the single OTel boundary.
 */
export interface SpanHandle {
	setAttribute(key: string, value: string | number | boolean): void;
	recordError(error: unknown): void;
	setStatus(status: 'ok' | 'error'): void;
	end(): void;
	readonly traceparent: string;
	readonly traceId: string;
}

export interface StartSpanOptions {
	readonly parent?: SpanHandle;
	readonly remoteParent?: string;
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface SpanTracer {
	startSpan(name: string, options?: StartSpanOptions): SpanHandle;
}

const INVALID_TRACE_ID = '00000000000000000000000000000000';

class OtelSpanHandle implements SpanHandle {
	constructor(readonly span: OtelSpan) {}

	setAttribute(key: string, value: string | number | boolean): void {
		this.span.setAttribute(key, value);
	}

	recordError(error: unknown): void {
		this.span.recordException(
			error instanceof Error ? error : String(error)
		);
		this.span.setStatus({ code: SpanStatusCode.ERROR });
	}

	setStatus(status: 'ok' | 'error'): void {
		this.span.setStatus({
			code: status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
		});
	}

	end(): void {
		this.span.end();
	}

	get traceId(): string {
		const { traceId } = this.span.spanContext();
		return traceId === INVALID_TRACE_ID ? '' : traceId;
	}

	get traceparent(): string {
		const { traceId, spanId, traceFlags } = this.span.spanContext();
		if (traceId === INVALID_TRACE_ID) return '';
		const flags = (traceFlags & 1) === 1 ? '01' : '00';
		return `00-${traceId}-${spanId}-${flags}`;
	}
}

/**
 * Builds a tracer that opens OTEL spans, threading parent linkage explicitly
 * (no reliance on ambient async context): a local `parent` span nests directly,
 * an inbound `remoteParent` traceparent continues a cross-service trace. Returns
 * no-op-backed spans when tracing was never initialized (`getTracer` warns once).
 */
export function createSpanTracer(name: string, version?: string): SpanTracer {
	const tracer = getTracer(name, version);
	return {
		startSpan(spanName, options) {
			let ctx = otelContext.active();
			if (options?.parent instanceof OtelSpanHandle) {
				ctx = trace.setSpan(ctx, options.parent.span);
			} else if (options?.remoteParent !== undefined) {
				const parsed = parseTraceparent(options.remoteParent);
				if (parsed.success) {
					ctx = trace.setSpanContext(ctx, {
						traceId: parsed.context.traceId,
						spanId: parsed.context.spanId,
						traceFlags: parsed.context.sampled ? 1 : 0,
						isRemote: true,
					});
				}
			}
			const span = tracer.startSpan(
				spanName,
				{ attributes: options?.attributes },
				ctx
			);
			return new OtelSpanHandle(span);
		},
	};
}
