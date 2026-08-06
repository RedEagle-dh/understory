import { type StaticDecode, type TSchema } from '@sinclair/typebox';
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
import type { FactoryDeps, IdempotencyStorePort, LoggerPort } from './ports';

/**
 * The context event pipeline stages see. The payload is untyped on purpose —
 * the typed event exists only in the handler, after schema parsing.
 */
export interface ConsumerContext extends EntrypointContext {
	readonly consumerId: string;
	readonly subject: string;
	readonly eventId: string | undefined;
	readonly attempt: number;
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly rawEvent: unknown;
}

export function defineConsumerStage<
	Decl extends object = object,
	Requires extends object = object,
	Provides extends object = object,
>(
	name: string,
	run: (
		decl: Decl,
		ctx: ConsumerContext & Requires
	) => Promise<StageOutcome<Provides>>
): Stage<ConsumerContext, Decl, Requires, Provides> {
	return defineStage<ConsumerContext, Decl, Requires, Provides>(name, run);
}

export type ConsumerHandlerContext<
	Provides extends object,
	Event extends TSchema,
> = Provides & {
	readonly requestId: string;
	readonly subject: string;
	readonly eventId: string | undefined;
	readonly attempt: number;
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly log: LoggerPort;
	readonly signal: AbortSignal;
	readonly event: StaticDecode<Event>;
};

export interface RetryPolicy {
	/** Total delivery attempts including the first one. */
	readonly attempts: number;
	readonly minDelayMs?: number;
	readonly maxDelayMs?: number;
}

export interface ConsumerShape<
	// Unused in the body by design: instantiated by ConsumerFactory as
	// `ConsumerShape<Decl, ...> & Decl`, so the declaration slots stay visible.
	_Decl extends object,
	Provides extends object,
	Event extends TSchema,
> {
	readonly id: string;
	/** Subject pattern this consumer subscribes to — reference into @declarativejs/contracts. */
	readonly subject: string;
	readonly event: Event;
	readonly errors?: readonly TypedErrorClass[];
	readonly retry?: RetryPolicy;
	/** Requires an IdempotencyStorePort on the factory. */
	readonly idempotent?: boolean;
	readonly idempotencyTtlSeconds?: number;
	readonly timeoutMs?: number;
	readonly handler: (
		ctx: ConsumerHandlerContext<Provides, Event>
	) => Promise<void>;
}

/**
 * What the transport adapter (packages/events) delivers per message. `attempt`
 * starts at 1 and comes from the broker's redelivery count.
 */
export interface InboundEventMessage {
	readonly subject: string;
	readonly payload: unknown;
	readonly eventId?: string;
	readonly attempt?: number;
	readonly headers?: Readonly<Record<string, string | undefined>>;
}

/**
 * The transport adapter maps this to the broker: ack, nak-with-delay, or
 * terminate-and-dead-letter.
 */
export type ConsumerOutcome =
	| { readonly kind: 'ack' }
	| { readonly kind: 'retry'; readonly delayMs: number }
	| { readonly kind: 'deadLetter'; readonly reason: string };

export interface ConsumerInstance {
	readonly id: string;
	readonly subject: string;
	readonly handle: (message: InboundEventMessage) => Promise<ConsumerOutcome>;
}

export interface ConsumerFactoryConfig<
	Decl extends object,
	Provides extends object,
> {
	readonly pipeline: Pipeline<ConsumerContext, Decl, Provides>;
	readonly deps: FactoryDeps;
	readonly idempotencyStore?: IdempotencyStorePort;
	readonly defaultTimeoutMs?: number;
	readonly defaultRetry?: RetryPolicy;
}

export type ConsumerFactory<Decl extends object, Provides extends object> = <
	Event extends TSchema,
>(
	def: ConsumerShape<Decl, Provides, Event> & Decl
) => ConsumerInstance;

const DEFAULT_RETRY: Required<RetryPolicy> = {
	attempts: 5,
	minDelayMs: 1_000,
	maxDelayMs: 60_000,
};
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86_400;

function backoffDelayMs(
	policy: Required<RetryPolicy>,
	attempt: number
): number {
	return Math.min(
		policy.maxDelayMs,
		policy.minDelayMs * 2 ** Math.max(0, attempt - 1)
	);
}

/**
 * The only way to create event handlers. Same frame as `route()`: pipeline
 * before every handler, schema-parsed payload, error boundary. Failure
 * classification (ADR-0009): deterministic rejections (validation, pipeline
 * halt, declared TypedErrors) go to the dead letter queue — retrying cannot fix
 * them; unknown errors retry with exponential backoff and are captured by the
 * ErrorSink once, when attempts are exhausted; timeouts retry without sink.
 */
export function createConsumerFactory<
	Decl extends object,
	Provides extends object,
>(
	config: ConsumerFactoryConfig<Decl, Provides>
): ConsumerFactory<Decl, Provides> {
	const { pipeline, deps, idempotencyStore, defaultTimeoutMs, defaultRetry } =
		config;

	return function consumer(def) {
		if (def.idempotent === true && idempotencyStore === undefined) {
			throw new Error(
				`Consumer ${def.id} declares idempotent: true but the factory has no IdempotencyStorePort`
			);
		}
		const retry: Required<RetryPolicy> = {
			attempts:
				def.retry?.attempts ??
				defaultRetry?.attempts ??
				DEFAULT_RETRY.attempts,
			minDelayMs:
				def.retry?.minDelayMs ??
				defaultRetry?.minDelayMs ??
				DEFAULT_RETRY.minDelayMs,
			maxDelayMs:
				def.retry?.maxDelayMs ??
				defaultRetry?.maxDelayMs ??
				DEFAULT_RETRY.maxDelayMs,
		};
		const timeoutMs = def.timeoutMs ?? defaultTimeoutMs ?? 30_000;
		const baseLabels = { consumer: def.id };

		async function handle(
			message: InboundEventMessage
		): Promise<ConsumerOutcome> {
			const requestId = deps.ids.requestId();
			const attempt = message.attempt ?? 1;
			const span = deps.tracer.startSpan(`event ${def.id}`, {
				remoteParent: message.headers?.['traceparent'],
				attributes: {
					'consumer.id': def.id,
					'messaging.destination': message.subject,
					'messaging.attempt': attempt,
				},
			});
			const log = deps.log.child({
				requestId,
				consumer: def.id,
				eventId: message.eventId,
				attempt,
				...(span.traceId !== '' ? { traceId: span.traceId } : {}),
			});
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			const startedAt = performance.now();

			const observeStage: StageObserver = (stage, durationMs) => {
				deps.metrics.observe('event_stage_duration_ms', durationMs, {
					...baseLabels,
					stage,
				});
			};

			const finish = (outcome: ConsumerOutcome): ConsumerOutcome => {
				deps.metrics.observe(
					'event_processing_duration_ms',
					performance.now() - startedAt,
					baseLabels
				);
				deps.metrics.increment('events_processed_total', {
					...baseLabels,
					result: outcome.kind,
				});
				span.setAttribute('messaging.outcome', outcome.kind);
				span.setStatus(outcome.kind === 'ack' ? 'ok' : 'error');
				return outcome;
			};

			const retryOrDeadLetter = (reason: string): ConsumerOutcome => {
				if (attempt >= retry.attempts)
					return finish({ kind: 'deadLetter', reason });
				return finish({
					kind: 'retry',
					delayMs: backoffDelayMs(retry, attempt),
				});
			};

			try {
				if (
					def.idempotent === true &&
					idempotencyStore !== undefined &&
					message.eventId !== undefined
				) {
					if (
						await idempotencyStore.hasSeen(def.id, message.eventId)
					) {
						log.debug('duplicate delivery skipped');
						deps.metrics.increment('events_processed_total', {
							...baseLabels,
							result: 'duplicate',
						});
						return { kind: 'ack' };
					}
				}

				const pipelineCtx: ConsumerContext = {
					requestId,
					consumerId: def.id,
					subject: message.subject,
					eventId: message.eventId,
					attempt,
					headers: message.headers ?? {},
					rawEvent: message.payload,
					log,
					signal: controller.signal,
				};

				const run = await pipeline.run(def, pipelineCtx, {
					observe: observeStage,
					tracer: deps.tracer,
					parentSpan: span,
				});
				if (run.kind === 'halt') {
					log.warn('event rejected by pipeline', {
						stage: run.stage,
						code: run.code,
					});
					return finish({
						kind: 'deadLetter',
						reason: `${run.stage}:${run.code}`,
					});
				}

				const event = ((): StaticDecode<typeof def.event> => {
					try {
						return Value.Parse(def.event, message.payload);
					} catch (error) {
						const detail =
							error instanceof Error
								? error.message
								: String(error);
						throw new ValidationFailedError([`event: ${detail}`]);
					}
				})();

				const handlerCtx = Object.assign(run.ctx, { event });
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
				await Promise.race([def.handler(handlerCtx), timeout]);

				if (
					def.idempotent === true &&
					idempotencyStore !== undefined &&
					message.eventId !== undefined
				) {
					await idempotencyStore.markSeen(
						def.id,
						message.eventId,
						def.idempotencyTtlSeconds ??
							DEFAULT_IDEMPOTENCY_TTL_SECONDS
					);
				}
				return finish({ kind: 'ack' });
			} catch (error) {
				if (error instanceof ValidationFailedError) {
					log.error(
						'poison message: payload failed schema validation',
						{ details: error.details }
					);
					return finish({ kind: 'deadLetter', reason: error.code });
				}
				if (matchesDeclaredError(error, def.errors)) {
					const typed: TypedError = error;
					log.warn('event rejected by declared error', {
						code: typed.code,
					});
					return finish({ kind: 'deadLetter', reason: typed.code });
				}
				if (error instanceof RequestTimeoutError) {
					log.error('event processing timed out', { timeoutMs });
					return retryOrDeadLetter(error.code);
				}
				log.error('unhandled error while processing event', {
					error:
						error instanceof Error ? error.message : String(error),
				});
				span.recordError(error);
				if (attempt >= retry.attempts) {
					deps.errorSink.capture(error, {
						entrypoint: 'consumer',
						requestId,
						route: def.id,
						traceId: span.traceId !== '' ? span.traceId : undefined,
						meta: {
							...baseLabels,
							subject: message.subject,
							eventId: message.eventId,
							attempt,
						},
					});
				}
				return retryOrDeadLetter('UNHANDLED');
			} finally {
				clearTimeout(timer);
				span.end();
			}
		}

		return { id: def.id, subject: def.subject, handle };
	};
}
