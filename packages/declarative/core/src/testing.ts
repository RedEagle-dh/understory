import type {
	AccessLogEntry,
	ErrorContext,
	FactoryDeps,
	IdempotencyStorePort,
	LoggerPort,
	Span,
	SpanAttributeValue,
	SpanOptions,
	TracerPort,
} from './ports';

export interface RecordedLog {
	readonly level: 'debug' | 'info' | 'warn' | 'error';
	readonly message: string;
	readonly fields?: Record<string, unknown>;
	readonly bindings: Record<string, unknown>;
}

export interface RecordedMetric {
	readonly name: string;
	readonly value?: number;
	readonly labels?: Record<string, string>;
}

export interface RecordedError {
	readonly error: unknown;
	readonly context: ErrorContext;
}

export interface RecordedSpan {
	readonly name: string;
	/** Name of the local parent span, if this span was opened as a child. */
	readonly parentName: string | undefined;
	/** Inbound traceparent this span continued, if any. */
	readonly remoteParent: string | undefined;
	readonly attributes: Record<string, SpanAttributeValue>;
	readonly errors: unknown[];
	readonly traceId: string;
	readonly traceparent: string;
	status: 'ok' | 'error' | undefined;
	ended: boolean;
}

export interface TestDeps {
	readonly deps: FactoryDeps;
	readonly idempotencyStore: IdempotencyStorePort;
	readonly seenEventIds: Set<string>;
	readonly logs: RecordedLog[];
	readonly counters: RecordedMetric[];
	readonly observations: RecordedMetric[];
	readonly capturedErrors: RecordedError[];
	/** Spans opened via the recording tracer, in creation order. */
	readonly spans: RecordedSpan[];
	/** Access-log entries recorded by the factories, in emission order. */
	readonly accessEntries: AccessLogEntry[];
}

/**
 * A Span backed by a mutable RecordedSpan so tests can inspect attributes,
 * status, errors and nesting. The parent linkage is by reference — a child's
 * `parent` is one of these instances, so `instanceof` recovers its record.
 */
class RecordingSpan implements Span {
	constructor(readonly record: RecordedSpan) {}
	setAttribute(key: string, value: SpanAttributeValue): void {
		this.record.attributes[key] = value;
	}
	recordError(error: unknown): void {
		this.record.errors.push(error);
		this.record.status = 'error';
	}
	setStatus(status: 'ok' | 'error'): void {
		this.record.status = status;
	}
	end(): void {
		this.record.ended = true;
	}
	get traceId(): string {
		return this.record.traceId;
	}
	get traceparent(): string {
		return this.record.traceparent;
	}
}

function recordingTracer(sink: RecordedSpan[]): TracerPort {
	let sequence = 0;
	return {
		startSpan(name: string, options?: SpanOptions): Span {
			sequence += 1;
			const parent =
				options?.parent instanceof RecordingSpan
					? options.parent.record
					: undefined;
			// Child spans and remote-continued spans share the parent's trace id.
			const traceId =
				parent?.traceId ??
				remoteTraceId(options?.remoteParent) ??
				`trace-${sequence}`;
			const record: RecordedSpan = {
				name,
				parentName: parent?.name,
				remoteParent: options?.remoteParent,
				attributes: { ...(options?.attributes ?? {}) },
				errors: [],
				traceId,
				traceparent: `00-${traceId}-span${sequence}0000000000-01`,
				status: undefined,
				ended: false,
			};
			sink.push(record);
			return new RecordingSpan(record);
		},
	};
}

/** Pulls the trace id out of an inbound W3C traceparent, if well-formed. */
function remoteTraceId(traceparent: string | undefined): string | undefined {
	if (traceparent === undefined) return undefined;
	const parts = traceparent.split('-');
	return parts.length === 4 ? parts[1] : undefined;
}

function recordingLogger(
	sink: RecordedLog[],
	bindings: Record<string, unknown>
): LoggerPort {
	const write =
		(level: RecordedLog['level']) =>
		(message: string, fields?: Record<string, unknown>) => {
			sink.push({ level, message, fields, bindings });
		};
	return {
		debug: write('debug'),
		info: write('info'),
		warn: write('warn'),
		error: write('error'),
		child: (childBindings) =>
			recordingLogger(sink, { ...bindings, ...childBindings }),
	};
}

/**
 * In-memory implementations of all factory ports, recording everything for
 * assertions. Lets agents test routes and pipelines without booting Elysia,
 * Postgres or NATS (ADR-0005).
 */
export function createTestDeps(): TestDeps {
	const logs: RecordedLog[] = [];
	const counters: RecordedMetric[] = [];
	const observations: RecordedMetric[] = [];
	const capturedErrors: RecordedError[] = [];
	const spans: RecordedSpan[] = [];
	const accessEntries: AccessLogEntry[] = [];
	const seenEventIds = new Set<string>();
	let sequence = 0;

	const idempotencyStore: IdempotencyStorePort = {
		hasSeen: async (consumerId, eventId) =>
			seenEventIds.has(`${consumerId}:${eventId}`),
		markSeen: async (consumerId, eventId) => {
			seenEventIds.add(`${consumerId}:${eventId}`);
		},
	};

	const deps: FactoryDeps = {
		log: recordingLogger(logs, {}),
		metrics: {
			increment: (name, labels) => counters.push({ name, labels }),
			observe: (name, value, labels) =>
				observations.push({ name, value, labels }),
		},
		tracer: recordingTracer(spans),
		errorSink: {
			capture: (error, context) =>
				capturedErrors.push({ error, context }),
		},
		ids: {
			requestId: () => `req-${++sequence}`,
			id: () => `id-${++sequence}`,
		},
		clock: {
			now: () => new Date('2026-01-01T00:00:00.000Z'),
		},
		accessLog: {
			record: (entry) => accessEntries.push(entry),
		},
	};

	return {
		deps,
		idempotencyStore,
		seenEventIds,
		logs,
		counters,
		observations,
		capturedErrors,
		spans,
		accessEntries,
	};
}
