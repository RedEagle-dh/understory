import { type StaticDecode, type TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import {
	matchesDeclaredError,
	RequestTimeoutError,
	TypedError,
	type TypedErrorClass,
	ValidationFailedError,
} from './errors';
import {
	defineStage,
	type EntrypointContext,
	Pipeline,
	type Stage,
	type StageObserver,
	type StageOutcome,
} from './pipeline';
import type {
	Attribution,
	FactoryDeps,
	HttpIdempotencyStorePort,
	IdempotencyScope,
	LoggerPort,
} from './ports';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The context HTTP pipeline stages see. Raw inputs are untyped on purpose —
 * typed params/query/body exist only in the handler, after schema parsing.
 */
export interface RequestContext extends EntrypointContext {
	readonly surface: string;
	readonly routeId: string;
	readonly headers: Readonly<Record<string, string | undefined>>;
	/** Client IP as resolved by the transport (trust-proxy is the mount's call). */
	readonly ip?: string;
	/** W3C traceparent of the entrypoint's root span — forward to UnitOfWork so emitted events continue the trace. */
	readonly traceparent: string;
	/** 32-hex trace id (empty if untraced) — echoed into logs automatically. */
	readonly traceId: string;
	readonly rawParams: unknown;
	readonly rawQuery: unknown;
	readonly rawBody: unknown;
}

export function defineRouteStage<
	Decl extends object = object,
	Requires extends object = object,
	Provides extends object = object,
>(
	name: string,
	run: (
		decl: Decl,
		ctx: RequestContext & Requires
	) => Promise<StageOutcome<Provides>>
): Stage<RequestContext, Decl, Requires, Provides> {
	return defineStage<RequestContext, Decl, Requires, Provides>(name, run);
}

export interface RouteDocs {
	readonly summary: string;
	readonly tag: string;
}

/**
 * What a handler receives: pipeline contributions plus schema-parsed inputs.
 * Deliberately small — db, cache, metrics and event bus do not exist for
 * handlers (ADR-0005).
 */
export type HandlerContext<
	Provides extends object,
	Params extends TSchema,
	Query extends TSchema,
	Body extends TSchema,
> = Provides & {
	readonly requestId: string;
	/** W3C traceparent of the request's root span — pass to UnitOfWork meta so events continue the trace. */
	readonly traceparent: string;
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly log: LoggerPort;
	readonly signal: AbortSignal;
	readonly params: StaticDecode<Params>;
	readonly query: StaticDecode<Query>;
	readonly body: StaticDecode<Body>;
};

/**
 * Schemas are mandatory: `params`/`query`/`body` describe (and are the only way
 * to receive) inputs, `response` is the egress filter and OpenAPI source. Use
 * `t.Object({})` / `t.Undefined()` explicitly where a route has no input.
 */
export interface RouteShape<
	// Unused in the body by design: instantiated by RouteFactory as
	// `RouteShape<Decl, ...> & Decl`, so the declaration slots stay visible.
	_Decl extends object,
	Provides extends object,
	Method extends HttpMethod,
	Path extends string,
	Params extends TSchema,
	Query extends TSchema,
	Body extends TSchema,
	Response extends TSchema,
> {
	readonly id: string;
	readonly method: Method;
	readonly path: Path;
	readonly params: Params;
	readonly query: Query;
	readonly body: Body;
	readonly response: Response;
	readonly errors?: readonly TypedErrorClass[];
	readonly successStatus?: number;
	readonly timeoutMs?: number;
	/**
	 * ONLY for sensitive reads (ADR-0010) — mutations audit automatically via
	 * domain events. Marks the access-log entry with this action so the audit
	 * projector copies it into the tenant audit trail (best-effort by design).
	 */
	readonly audit?: { readonly action: string };
	/**
	 * Response-replay idempotency via the `Idempotency-Key` header. Requires
	 * an HttpIdempotencyStorePort on the factory and a pipeline that resolves
	 * actor + tenant attribution.
	 */
	readonly idempotency?: true;
	readonly docs?: RouteDocs;
	readonly handler: (
		ctx: HandlerContext<Provides, Params, Query, Body>
	) => Promise<StaticDecode<Response>>;
}

export interface RawRequestInput {
	readonly params?: unknown;
	readonly query?: unknown;
	readonly body?: unknown;
	readonly headers?: Readonly<Record<string, string | undefined>>;
	readonly ip?: string;
}

export interface RouteResult {
	readonly status: number;
	readonly body: unknown;
	/** Always carries the x-request-id echo; the transport must apply these. */
	readonly headers: Readonly<Record<string, string>>;
}

/** The declared I/O schemas, exposed for OpenAPI generation and schema audits. */
export interface RouteSchemas<
	Params extends TSchema = TSchema,
	Query extends TSchema = TSchema,
	Body extends TSchema = TSchema,
	Response extends TSchema = TSchema,
> {
	readonly params: Params;
	readonly query: Query;
	readonly body: Body;
	readonly response: Response;
}

/**
 * Generic over the declared method/path/schemas so typed clients (Eden treaty
 * via `EdenApp`, see eden.ts) can be derived from route arrays. The defaults
 * keep `RouteInstance` usable un-parameterized everywhere the types don't
 * matter (mounting, OpenAPI) — runtime behavior is identical either way.
 */
export interface RouteInstance<
	Method extends HttpMethod = HttpMethod,
	Path extends string = string,
	Params extends TSchema = TSchema,
	Query extends TSchema = TSchema,
	Body extends TSchema = TSchema,
	Response extends TSchema = TSchema,
> {
	readonly id: string;
	readonly method: Method;
	readonly path: Path;
	readonly surface: string;
	readonly docs?: RouteDocs;
	readonly schemas: RouteSchemas<Params, Query, Body, Response>;
	readonly execute: (input: RawRequestInput) => Promise<RouteResult>;
}

export interface RouteFactoryConfig<
	Decl extends object,
	Provides extends object,
> {
	readonly surface: string;
	readonly pipeline: Pipeline<RequestContext, Decl, Provides>;
	readonly deps: FactoryDeps;
	readonly defaultTimeoutMs?: number;
	/** Required by routes declaring `idempotency: true` — absent, they fail at definition. */
	readonly idempotencyStore?: HttpIdempotencyStorePort;
	/** Replay window for stored idempotent responses. Default 24h. */
	readonly idempotencyTtlSeconds?: number;
	/**
	 * Projects the resolved request context onto actor/tenant strings for the
	 * error boundary and access log. Supplied by the composition root, which
	 * knows the pipeline's domain Provides; reads a possibly-partial context
	 * (a request that halted at authn has no tenant, one that halted before
	 * authn has no actor), so every field is optional (ADR-0009).
	 */
	readonly attribution?: (
		ctx: RequestContext & Partial<Provides>
	) => Attribution;
}

export type RouteFactory<Decl extends object, Provides extends object> = <
	Method extends HttpMethod,
	Path extends string,
	Params extends TSchema,
	Query extends TSchema,
	Body extends TSchema,
	Response extends TSchema,
>(
	def: RouteShape<
		Decl,
		Provides,
		Method,
		Path,
		Params,
		Query,
		Body,
		Response
	> &
		Decl
) => RouteInstance<Method, Path, Params, Query, Body, Response>;

function statusClass(status: number): string {
	return `${Math.floor(status / 100)}xx`;
}

/**
 * A handler returned a value its declared response schema rejects after the
 * egress filter stripped undeclared fields. Always a bug in the handler, never
 * a caller error — surfaces as 500 + ErrorSink via the undeclared-error path.
 */
class ResponseSchemaViolationError extends Error {
	constructor(routeId: string, detail: string) {
		super(`route ${routeId} violated its response schema: ${detail}`);
	}
}

/**
 * Ingress arrays without maxItems are an unbounded allocation an attacker
 * controls (ADR-0014 #7). Checked once at definition time — a violating route
 * fails at composition, before it can ever serve traffic.
 */
function assertBoundedIngressArrays(
	routeId: string,
	schemas: Readonly<Record<string, TSchema>>
): void {
	const violations: string[] = [];
	for (const [section, schema] of Object.entries(schemas)) {
		collectUnboundedArrays(schema, section, violations, new Set());
	}
	if (violations.length > 0) {
		throw new Error(
			`route ${routeId} declares ingress arrays without maxItems: ${violations.join(', ')}`
		);
	}
}

function collectUnboundedArrays(
	node: unknown,
	path: string,
	sink: string[],
	seen: Set<object>
): void {
	if (typeof node !== 'object' || node === null || seen.has(node)) return;
	seen.add(node);
	if (
		'type' in node &&
		node.type === 'array' &&
		!('maxItems' in node && typeof node.maxItems === 'number')
	) {
		sink.push(path);
	}
	for (const [key, value] of Object.entries(node)) {
		collectUnboundedArrays(value, `${path}.${key}`, sink, seen);
	}
}

function parseOrFail<Schema extends TSchema>(
	schema: Schema,
	value: unknown,
	source: string
): StaticDecode<Schema> {
	try {
		return Value.Parse(schema, value);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ValidationFailedError([`${source}: ${detail}`]);
	}
}

/**
 * The only way to create HTTP endpoints. Runs the app's pipeline before every
 * handler, parses inputs against the declared schemas, maps declared TypedErrors,
 * treats everything undeclared as a bug (500 + ErrorSink) and records RED metrics
 * per stage (ADR-0005, ADR-0009).
 */
export function createRouteFactory<
	Decl extends object,
	Provides extends object,
>(config: RouteFactoryConfig<Decl, Provides>): RouteFactory<Decl, Provides> {
	const { surface, pipeline, deps, defaultTimeoutMs, attribution } = config;
	const idempotencyTtlSeconds = config.idempotencyTtlSeconds ?? 86_400;

	return function route(def) {
		const timeoutMs = def.timeoutMs ?? defaultTimeoutMs ?? 30_000;
		const baseLabels = { route: def.id, surface, method: def.method };
		assertBoundedIngressArrays(def.id, {
			params: def.params,
			query: def.query,
			body: def.body,
		});
		const idempotencyStore = config.idempotencyStore ?? null;
		if (def.idempotency === true && idempotencyStore === null) {
			throw new Error(
				`route ${def.id} declares idempotency: true but the factory has no HttpIdempotencyStorePort`
			);
		}
		// Compiled once per route: the egress filter (ADR-0005) — undeclared
		// fields are stripped, a post-strip mismatch is a handler bug.
		const responseCheck = TypeCompiler.Compile(def.response);

		async function execute(input: RawRequestInput): Promise<RouteResult> {
			const requestId = deps.ids.requestId();
			const span = deps.tracer.startSpan(`${def.method} ${def.id}`, {
				remoteParent: input.headers?.['traceparent'],
				attributes: {
					'route.id': def.id,
					'route.surface': surface,
					'http.method': def.method,
					'http.route': def.path,
				},
			});
			const log = deps.log.child({
				requestId,
				route: def.id,
				...(span.traceId !== '' ? { traceId: span.traceId } : {}),
			});
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			const startedAt = performance.now();

			// The pipeline assigns each stage's provides onto this object, so at
			// any moment — including a halt — it holds a partial set. Typing it
			// as Partial<Provides> lets attribution read it at every exit path
			// (a request denied by policy still gets its actor attributed).
			const pipelineCtx: RequestContext & Partial<Provides> =
				Object.assign<RequestContext, Partial<Provides>>(
					{
						requestId,
						surface,
						routeId: def.id,
						headers: input.headers ?? {},
						ip: input.ip,
						traceparent: span.traceparent,
						traceId: span.traceId,
						rawParams: input.params,
						rawQuery: input.query,
						rawBody: input.body,
						log,
						signal: controller.signal,
					},
					{}
				);
			const who = (): Attribution => attribution?.(pipelineCtx) ?? {};
			// Non-null between a fresh begin() and its complete()/abandon().
			let idemScope: IdempotencyScope | null = null;

			const observeStage: StageObserver = (stage, durationMs) => {
				deps.metrics.observe('http_stage_duration_ms', durationMs, {
					...baseLabels,
					stage,
				});
			};

			const finish = (
				status: number,
				body: unknown,
				headers?: Readonly<Record<string, string>>
			): RouteResult => {
				const durationMs = performance.now() - startedAt;
				deps.metrics.observe(
					'http_request_duration_ms',
					durationMs,
					baseLabels
				);
				deps.metrics.increment('http_requests_total', {
					...baseLabels,
					status: statusClass(status),
				});
				span.setAttribute('http.status_code', status);
				span.setStatus(status >= 500 ? 'error' : 'ok');
				const attributed = who();
				deps.accessLog?.record({
					routeId: def.id,
					surface,
					method: def.method,
					status,
					durationMs,
					requestId,
					traceId: span.traceId !== '' ? span.traceId : undefined,
					actorType: attributed.actorType,
					actorId: attributed.actorId,
					tenantId: attributed.tenantId,
					ip: input.ip,
					userAgent: input.headers?.['user-agent'],
					audit: def.audit?.action,
					occurredAt: deps.clock.now().toISOString(),
				});
				return {
					status,
					body,
					headers: { 'x-request-id': requestId, ...headers },
				};
			};

			try {
				const run = await pipeline.run(def, pipelineCtx, {
					observe: observeStage,
					tracer: deps.tracer,
					parentSpan: span,
				});
				if (run.kind === 'halt') {
					log.warn('request halted by pipeline', {
						stage: run.stage,
						code: run.code,
						status: run.status,
					});
					return finish(
						run.status,
						{
							error: run.code,
							message: run.message,
							requestId,
						},
						run.headers
					);
				}

				const params = parseOrFail(def.params, input.params, 'params');
				const query = parseOrFail(def.query, input.query, 'query');
				const body = parseOrFail(def.body, input.body, 'body');

				// Idempotency (after validation: 422s never claim the key).
				if (def.idempotency === true && idempotencyStore !== null) {
					const key = input.headers?.['idempotency-key'];
					if (key === undefined || key === '') {
						return finish(400, {
							error: 'IDEMPOTENCY_KEY_REQUIRED',
							requestId,
						});
					}
					const attributed = who();
					if (
						attributed.actorId === undefined ||
						attributed.tenantId === undefined
					) {
						// Composition bug, not a caller error: the route wants
						// idempotency but its pipeline resolves no actor/tenant.
						deps.errorSink.capture(
							new Error(
								`route ${def.id} declares idempotency but attribution resolved no actor/tenant`
							),
							{ entrypoint: 'route', requestId, route: def.id }
						);
						return finish(500, { error: 'INTERNAL', requestId });
					}
					idemScope = {
						surface,
						routeId: def.id,
						actorId: attributed.actorId,
						tenantId: attributed.tenantId,
						key,
					};
					const begin = await idempotencyStore.begin(
						idemScope,
						idempotencyTtlSeconds
					);
					if (begin.kind === 'replay') {
						idemScope = null;
						return finish(
							begin.response.status,
							begin.response.body,
							{ 'idempotency-replayed': 'true' }
						);
					}
					if (begin.kind === 'in-progress') {
						idemScope = null;
						return finish(409, {
							error: 'IDEMPOTENCY_IN_PROGRESS',
							requestId,
						});
					}
				}

				const handlerCtx = Object.assign(run.ctx, {
					params,
					query,
					body,
				});
				const timeout = new Promise<never>((_resolve, reject) => {
					controller.signal.addEventListener(
						'abort',
						() =>
							reject(new RequestTimeoutError(def.id, timeoutMs)),
						{
							once: true,
						}
					);
				});
				const result = await Promise.race([
					def.handler(handlerCtx),
					timeout,
				]);
				const cleaned = Value.Clean(def.response, result);
				if (!responseCheck.Check(cleaned)) {
					const first = responseCheck.Errors(cleaned).First();
					throw new ResponseSchemaViolationError(
						def.id,
						first === undefined
							? 'unknown mismatch'
							: `${first.path}: ${first.message}`
					);
				}
				const status = def.successStatus ?? 200;
				if (idemScope !== null && idempotencyStore !== null) {
					// The operation DID happen — a failing store write must not
					// fail the response; it only costs the replay.
					const scope = idemScope;
					idemScope = null;
					try {
						await idempotencyStore.complete(scope, {
							status,
							body: cleaned,
						});
					} catch (error) {
						log.warn('idempotency complete failed — replay lost', {
							error:
								error instanceof Error
									? error.message
									: String(error),
						});
						await idempotencyStore
							.abandon(scope)
							.catch(() => undefined);
					}
				}
				return finish(status, cleaned);
			} catch (error) {
				if (idemScope !== null && idempotencyStore !== null) {
					// Failure: release the key so the client can retry it.
					const scope = idemScope;
					idemScope = null;
					await idempotencyStore
						.abandon(scope)
						.catch(() => undefined);
				}
				if (
					matchesDeclaredError(error, def.errors) ||
					error instanceof ValidationFailedError
				) {
					const typed: TypedError = error;
					return finish(typed.status, {
						error: typed.code,
						message: typed.expose ? typed.message : undefined,
						requestId,
					});
				}
				if (error instanceof RequestTimeoutError) {
					log.error('request timed out', { timeoutMs });
					return finish(error.status, {
						error: error.code,
						requestId,
					});
				}
				log.error('unhandled error', {
					error:
						error instanceof Error ? error.message : String(error),
				});
				span.recordError(error);
				const attributed = who();
				deps.errorSink.capture(error, {
					entrypoint: 'route',
					requestId,
					route: def.id,
					traceId: span.traceId !== '' ? span.traceId : undefined,
					actorType: attributed.actorType,
					actorId: attributed.actorId,
					tenantId: attributed.tenantId,
					meta: baseLabels,
				});
				return finish(500, { error: 'INTERNAL', requestId });
			} finally {
				clearTimeout(timer);
				span.end();
			}
		}

		return {
			id: def.id,
			method: def.method,
			path: def.path,
			surface,
			docs: def.docs,
			schemas: {
				params: def.params,
				query: def.query,
				body: def.body,
				response: def.response,
			},
			execute,
		};
	};
}
