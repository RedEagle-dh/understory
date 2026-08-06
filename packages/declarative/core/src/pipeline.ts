import type { LoggerPort, Span, TracerPort } from './ports';

/** The minimal context every entrypoint kind shares. */
export interface EntrypointContext {
	readonly requestId: string;
	readonly log: LoggerPort;
	readonly signal: AbortSignal;
}

export type StageOutcome<Provides extends object> =
	| { readonly kind: 'continue'; readonly provide: Provides }
	| {
			readonly kind: 'halt';
			readonly status: number;
			readonly code: string;
			readonly message?: string;
			/** Response headers the transport must carry (e.g. Retry-After on 429). */
			readonly headers?: Readonly<Record<string, string>>;
	  };

export function provide<Provides extends object>(
	provides: Provides
): StageOutcome<Provides> {
	return { kind: 'continue', provide: provides };
}

export function halt(
	status: number,
	code: string,
	message?: string,
	headers?: Readonly<Record<string, string>>
): StageOutcome<never> {
	return { kind: 'halt', status, code, message, headers };
}

/**
 * A pipeline stage over a base context (HTTP request, event delivery, ...).
 * `Decl` is what the stage requires on the endpoint declaration (e.g. the policy
 * stage requires a `policy` field — omitting it is a compile error). `Requires`
 * is what it needs on the context from earlier stages; `Provides` is what it
 * contributes to the handler context.
 *
 * `run` is a property (not a method) so TypeScript checks `Requires`
 * contravariantly: composing a stage whose requirements are not yet provided
 * fails to compile.
 */
export interface Stage<
	Base extends EntrypointContext,
	Decl extends object,
	Requires extends object,
	Provides extends object,
> {
	readonly name: string;
	readonly run: (
		decl: Decl,
		ctx: Base & Requires
	) => Promise<StageOutcome<Provides>>;
}

export function defineStage<
	Base extends EntrypointContext,
	Decl extends object = object,
	Requires extends object = object,
	Provides extends object = object,
>(
	name: string,
	run: (decl: Decl, ctx: Base & Requires) => Promise<StageOutcome<Provides>>
): Stage<Base, Decl, Requires, Provides> {
	return { name, run };
}

export type PipelineRun<
	Base extends EntrypointContext,
	Provides extends object,
> =
	| { readonly kind: 'ok'; readonly ctx: Base & Provides }
	| {
			readonly kind: 'halt';
			readonly status: number;
			readonly code: string;
			readonly message?: string;
			readonly headers?: Readonly<Record<string, string>>;
			readonly stage: string;
	  };

export type StageObserver = (stage: string, durationMs: number) => void;

/**
 * Cross-cutting instrumentation the factory hands to the runner. All optional
 * so a bare `run()` (e.g. in unit tests) stays valid; the route/consumer
 * factories always supply the tracer and root span (ADR-0009). Each stage runs
 * inside a child span of `parentSpan`.
 */
export interface PipelineInstrumentation {
	readonly observe?: StageObserver;
	readonly tracer?: TracerPort;
	readonly parentSpan?: Span;
}

/**
 * Ordered, typed composition of stages. Built once per app in the composition
 * root; `use()` accumulates both the declaration requirements and the context
 * contributions in the type system.
 */
export class Pipeline<
	Base extends EntrypointContext,
	Decl extends object,
	Provides extends object,
> {
	private constructor(
		private readonly runner: (
			decl: Decl,
			ctx: Base,
			instr?: PipelineInstrumentation
		) => Promise<PipelineRun<Base, Provides>>
	) {}

	static empty<Base extends EntrypointContext>(): Pipeline<
		Base,
		object,
		object
	> {
		return new Pipeline<Base, object, object>(
			async (_decl, ctx): Promise<PipelineRun<Base, object>> => ({
				kind: 'ok',
				ctx,
			})
		);
	}

	use<StageDecl extends object, StageProvides extends object>(
		stage: Stage<Base, StageDecl, Provides, StageProvides>
	): Pipeline<Base, Decl & StageDecl, Provides & StageProvides> {
		const previous = this.runner;
		return new Pipeline<Base, Decl & StageDecl, Provides & StageProvides>(
			async (
				decl,
				ctx,
				instr
			): Promise<PipelineRun<Base, Provides & StageProvides>> => {
				const prior = await previous(decl, ctx, instr);
				if (prior.kind !== 'ok') return prior;
				const span = instr?.tracer?.startSpan(`stage.${stage.name}`, {
					parent: instr.parentSpan,
				});
				const startedAt = performance.now();
				try {
					const outcome = await stage.run(decl, prior.ctx);
					instr?.observe?.(stage.name, performance.now() - startedAt);
					if (outcome.kind === 'halt') {
						span?.setAttribute('halt.code', outcome.code);
						span?.setStatus('error');
						return {
							kind: 'halt',
							status: outcome.status,
							code: outcome.code,
							message: outcome.message,
							headers: outcome.headers,
							stage: stage.name,
						};
					}
					span?.setStatus('ok');
					return {
						kind: 'ok',
						ctx: Object.assign(prior.ctx, outcome.provide),
					};
				} catch (error) {
					span?.recordError(error);
					throw error;
				} finally {
					span?.end();
				}
			}
		);
	}

	run(
		decl: Decl,
		ctx: Base,
		instr?: PipelineInstrumentation
	): Promise<PipelineRun<Base, Provides>> {
		return this.runner(decl, ctx, instr);
	}
}

export function pipeline<Base extends EntrypointContext>(): Pipeline<
	Base,
	object,
	object
> {
	return Pipeline.empty<Base>();
}
