/**
 * Ports the framework and its consumers program against. Concrete adapters are
 * wired exclusively in each app's composition root (ADR-0005).
 */

export interface LoggerPort {
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
	child(bindings: Record<string, unknown>): LoggerPort;
}

export interface MetricsPort {
	/** Increment a counter by 1. Labels must stay low-cardinality — never tenantId (ADR-0009). */
	increment(name: string, labels?: Record<string, string>): void;
	/** Record a duration observation in milliseconds (histogram). */
	observe(
		name: string,
		valueMs: number,
		labels?: Record<string, string>
	): void;
}

export interface ErrorContext {
	readonly entrypoint: string;
	readonly requestId: string;
	readonly stage?: string;
	/** Entrypoint id (route/consumer) the error occurred in. */
	readonly route?: string;
	/** 32-hex trace id — the deep-link back to the trace/logs (ADR-0009). */
	readonly traceId?: string;
	/** Resolved caller, if authentication got that far. */
	readonly actorType?: string;
	readonly actorId?: string;
	/** Resolved tenant, if a policy stage minted one. Allowed here (ADR-0009). */
	readonly tenantId?: string;
	readonly meta?: Record<string, unknown>;
}

export interface ErrorSinkPort {
	capture(error: unknown, context: ErrorContext): void;
}

/**
 * A domain-agnostic projection of "who the request was for", read at the error
 * boundary and (Slice 3) the access log. The framework cannot name the domain
 * Actor/TenantContext types (ADR-0012), so the composition root supplies an
 * extractor that maps the pipeline's resolved context onto these strings.
 */
export interface Attribution {
	readonly actorType?: string;
	readonly actorId?: string;
	readonly tenantId?: string;
}

/**
 * One access-log line per request (ADR-0010): uniform envelope, high volume,
 * emitted automatically at the end of the route pipeline — success, halt and
 * 500 alike. Telemetry, not product data.
 */
export interface AccessLogEntry {
	readonly routeId: string;
	readonly surface: string;
	readonly method: string;
	readonly status: number;
	readonly durationMs: number;
	readonly requestId: string;
	readonly traceId?: string;
	readonly actorType?: string;
	readonly actorId?: string;
	readonly tenantId?: string;
	readonly ip?: string;
	readonly userAgent?: string;
	/**
	 * Set when the route declares `audit:` (sensitive reads, ADR-0010): the
	 * audit projector additionally writes these entries into the tenant-scoped
	 * audit trail. Mutations never set this — their audit path is the outbox.
	 */
	readonly audit?: string;
	readonly occurredAt: string;
}

/**
 * Sink for access-log entries. Implementations must be fire-and-forget:
 * never block, never throw into the request path (ADR-0010 — "never a
 * synchronous write in the request path").
 */
export interface AccessLogPort {
	record(entry: AccessLogEntry): void;
}

/** A low-cardinality span attribute value. */
export type SpanAttributeValue = string | number | boolean;

/**
 * One span in a trace. The adapter maps it onto OpenTelemetry (ADR-0009);
 * the framework only ever sees this port. A span may carry `tenantId` as an
 * attribute (unlike metric labels, ADR-0009's cardinality rule).
 */
export interface Span {
	setAttribute(key: string, value: SpanAttributeValue): void;
	/** Records an exception against the span and marks it failed. */
	recordError(error: unknown): void;
	setStatus(status: 'ok' | 'error'): void;
	end(): void;
	/** W3C traceparent — propagate into emitted events and downstream calls. */
	readonly traceparent: string;
	/** 32-hex trace id for log correlation and Grafana deep-links (empty if untraced). */
	readonly traceId: string;
}

export interface SpanOptions {
	/** Local parent span — the new span becomes its child (per-stage nesting). */
	readonly parent?: Span;
	/** An inbound W3C traceparent to continue a remote trace (root spans only). */
	readonly remoteParent?: string;
	readonly attributes?: Readonly<Record<string, SpanAttributeValue>>;
}

/**
 * Opens spans. One root span per entrypoint, one child span per pipeline stage
 * (ADR-0009) — created inside the factories/pipeline, never in handlers.
 */
export interface TracerPort {
	startSpan(name: string, options?: SpanOptions): Span;
}

export interface IdGeneratorPort {
	requestId(): string;
	id(): string;
}

export interface ClockPort {
	now(): Date;
}

export interface CachePort {
	get(namespace: string, key: string): Promise<unknown | undefined>;
	set(
		namespace: string,
		key: string,
		value: unknown,
		ttlSeconds: number
	): Promise<void>;
	delete(namespace: string, key: string): Promise<void>;
	/**
	 * Drop every key of a namespace at once (delete-on-write invalidation,
	 * ADR-0005). Implementations must make this atomic — e.g. a generation
	 * counter bump — so concurrent writers cannot lose an invalidation.
	 */
	invalidateNamespace(namespace: string): Promise<void>;
}

export interface PublishOptions {
	/** Deduplication id (e.g. Nats-Msg-Id) — the broker drops duplicates within its window. */
	readonly eventId?: string;
	/** Extra headers, e.g. traceparent for cross-service tracing. */
	readonly headers?: Readonly<Record<string, string>>;
}

export interface EventPublisherPort {
	publish(
		subject: string,
		payload: unknown,
		options?: PublishOptions
	): Promise<void>;
}

export interface RateLimitDecision {
	readonly allowed: boolean;
	/** Seconds until the bucket resets — echoed as Retry-After on 429. */
	readonly retryAfterSeconds?: number;
}

/**
 * Counting rate limiter (fixed window or better — the adapter's choice).
 * Implementations must fail OPEN on backend errors: limits protect capacity,
 * they are not authorization.
 */
export interface RateLimiterPort {
	consume(
		bucket: string,
		key: string,
		limit: number,
		windowSeconds: number
	): Promise<RateLimitDecision>;
}

/** Identifies one idempotent request attempt; replay is per actor (ADR-0005). */
export interface IdempotencyScope {
	readonly surface: string;
	readonly routeId: string;
	readonly actorId: string;
	/** RLS home of the stored response — originates from the minted TenantContext via attribution. */
	readonly tenantId: string;
	readonly key: string;
}

export interface StoredIdempotentResponse {
	readonly status: number;
	readonly body: unknown;
}

export type IdempotencyBegin =
	| { readonly kind: 'fresh' }
	| { readonly kind: 'in-progress' }
	| { readonly kind: 'replay'; readonly response: StoredIdempotentResponse };

/**
 * Response-replay store for `route()` idempotency (Stripe-style): the first
 * request claims the key, duplicates during execution answer 409, completed
 * responses replay until expiry. Distinct from the consumer's seen/markSeen
 * store on purpose — HTTP replay needs the response, event dedup does not.
 */
export interface HttpIdempotencyStorePort {
	begin(
		scope: IdempotencyScope,
		ttlSeconds: number
	): Promise<IdempotencyBegin>;
	/** Persist the response for replay. Called only for successful outcomes. */
	complete(
		scope: IdempotencyScope,
		response: StoredIdempotentResponse
	): Promise<void>;
	/** Release the claim after a failure so the client can retry the same key. */
	abandon(scope: IdempotencyScope): Promise<void>;
}

/**
 * Deduplication store for `consumer()` idempotency: JetStream is at-least-once,
 * so redeliveries of already-processed events must be detected and acked.
 */
export interface IdempotencyStorePort {
	hasSeen(consumerId: string, eventId: string): Promise<boolean>;
	markSeen(
		consumerId: string,
		eventId: string,
		ttlSeconds: number
	): Promise<void>;
}

/** The dependency set every entrypoint factory needs. */
export interface FactoryDeps {
	readonly log: LoggerPort;
	readonly metrics: MetricsPort;
	readonly tracer: TracerPort;
	readonly errorSink: ErrorSinkPort;
	readonly ids: IdGeneratorPort;
	readonly clock: ClockPort;
	/** Absent => no access log is emitted (e.g. unit tests, local scripts). */
	readonly accessLog?: AccessLogPort;
}
