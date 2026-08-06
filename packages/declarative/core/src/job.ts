import { nextCronOccurrence, parseCron } from './cron';
import {
	defineStage,
	type EntrypointContext,
	Pipeline,
	type Stage,
	type StageObserver,
	type StageOutcome,
} from './pipeline';
import type { FactoryDeps, LoggerPort } from './ports';

/**
 * The context job pipeline stages see. Jobs have no caller: no headers, no
 * raw inputs — the schedule is the trigger, the actor is the system.
 */
export interface JobContext extends EntrypointContext {
	readonly jobId: string;
	/** The tick this run answers (schedule time, not start time). */
	readonly scheduledFor: Date;
	readonly trigger: JobTrigger;
	/** W3C traceparent of the run's root span — pass to UnitOfWork meta. */
	readonly traceparent: string;
	readonly traceId: string;
}

export type JobTrigger = 'schedule' | 'manual';

export function defineJobStage<
	Decl extends object = object,
	Requires extends object = object,
	Provides extends object = object,
>(
	name: string,
	run: (
		decl: Decl,
		ctx: JobContext & Requires
	) => Promise<StageOutcome<Provides>>
): Stage<JobContext, Decl, Requires, Provides> {
	return defineStage<JobContext, Decl, Requires, Provides>(name, run);
}

/**
 * Cron (minute resolution, local time) or a fixed interval for sub-minute
 * cadence. Parsed at definition time — an invalid expression fails at
 * composition, before the scheduler ever starts.
 */
export type JobSchedule =
	| { readonly cron: string }
	| { readonly everyMs: number };

export type JobHandlerContext<Provides extends object> = Provides & {
	readonly requestId: string;
	readonly jobId: string;
	readonly scheduledFor: Date;
	readonly trigger: JobTrigger;
	readonly traceparent: string;
	readonly log: LoggerPort;
	readonly signal: AbortSignal;
};

export interface JobShape<
	// Unused in the body by design: instantiated by JobFactory as
	// `JobShape<Decl, ...> & Decl`, so the declaration slots stay visible.
	_Decl extends object,
	Provides extends object,
> {
	readonly id: string;
	readonly schedule: JobSchedule;
	readonly timeoutMs?: number;
	readonly handler: (ctx: JobHandlerContext<Provides>) => Promise<void>;
}

export type JobRunResult =
	| { readonly kind: 'ok'; readonly durationMs: number }
	| { readonly kind: 'failed'; readonly durationMs: number }
	/** `overlap`: the previous run is still in flight. `halted`: a pipeline stage (e.g. flag gate) said no. */
	| { readonly kind: 'skipped'; readonly reason: string };

export interface JobInstance {
	readonly id: string;
	readonly schedule: JobSchedule;
	/**
	 * Executes one run. The scheduler calls this per tick; `manual` triggers
	 * (an admin "run now") share the same frame and the same overlap guard.
	 */
	readonly run: (
		trigger: JobTrigger,
		scheduledFor?: Date
	) => Promise<JobRunResult>;
}

export interface JobFactoryConfig<
	Decl extends object,
	Provides extends object,
> {
	readonly pipeline: Pipeline<JobContext, Decl, Provides>;
	readonly deps: FactoryDeps;
	/** Jobs default to a generous frame — they are not request-shaped. */
	readonly defaultTimeoutMs?: number;
}

export type JobFactory<Decl extends object, Provides extends object> = (
	def: JobShape<Decl, Provides> & Decl
) => JobInstance;

const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000;

/**
 * The only way to create scheduled entrypoints (ADR-0005: same pipeline
 * mechanics, job-shaped stage selection). One run = one root span, one child
 * logger, stage + RED metrics, an error boundary that captures to the
 * ErrorSink — a failed run never breaks the schedule; the next tick fires.
 * Overlapping ticks are skipped, never queued: a job slower than its cadence
 * is a capacity signal, not a backlog to burn down.
 */
export function createJobFactory<Decl extends object, Provides extends object>(
	config: JobFactoryConfig<Decl, Provides>
): JobFactory<Decl, Provides> {
	const { pipeline, deps } = config;

	return function job(def) {
		// Validate the schedule at definition time (parity with route schema
		// checks): a bad cron fails at composition, not at 03:00.
		if ('cron' in def.schedule) parseCron(def.schedule.cron);
		else if (
			!Number.isInteger(def.schedule.everyMs) ||
			def.schedule.everyMs < 1_000
		) {
			throw new Error(
				`job ${def.id}: everyMs must be an integer >= 1000, got ${def.schedule.everyMs}`
			);
		}
		const timeoutMs =
			def.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
		const baseLabels = { job: def.id };
		let inFlight = false;

		async function run(
			trigger: JobTrigger,
			scheduledFor?: Date
		): Promise<JobRunResult> {
			if (inFlight) {
				deps.log.warn(
					'job tick skipped — previous run still in flight',
					{
						job: def.id,
					}
				);
				deps.metrics.increment('job_runs_total', {
					...baseLabels,
					result: 'overlap',
				});
				return { kind: 'skipped', reason: 'overlap' };
			}
			inFlight = true;
			const requestId = deps.ids.requestId();
			const tick = scheduledFor ?? deps.clock.now();
			const span = deps.tracer.startSpan(`job ${def.id}`, {
				attributes: { 'job.id': def.id, 'job.trigger': trigger },
			});
			const log = deps.log.child({
				requestId,
				job: def.id,
				trigger,
				...(span.traceId !== '' ? { traceId: span.traceId } : {}),
			});
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			const startedAt = performance.now();

			const observeStage: StageObserver = (stage, durationMs) => {
				deps.metrics.observe('job_stage_duration_ms', durationMs, {
					...baseLabels,
					stage,
				});
			};
			const finish = (result: JobRunResult): JobRunResult => {
				deps.metrics.observe(
					'job_run_duration_ms',
					performance.now() - startedAt,
					baseLabels
				);
				deps.metrics.increment('job_runs_total', {
					...baseLabels,
					result:
						result.kind === 'skipped' ? result.reason : result.kind,
				});
				span.setStatus(result.kind === 'failed' ? 'error' : 'ok');
				return result;
			};

			try {
				const jobCtx: JobContext = {
					requestId,
					jobId: def.id,
					scheduledFor: tick,
					trigger,
					traceparent: span.traceparent,
					traceId: span.traceId,
					log,
					signal: controller.signal,
				};
				const runOutcome = await pipeline.run(def, jobCtx, {
					observe: observeStage,
					tracer: deps.tracer,
					parentSpan: span,
				});
				if (runOutcome.kind === 'halt') {
					// A halt is a gate (flag off, precondition), not a failure.
					log.info('job run halted by pipeline', {
						stage: runOutcome.stage,
						code: runOutcome.code,
					});
					return finish({
						kind: 'skipped',
						reason: `${runOutcome.stage}:${runOutcome.code}`,
					});
				}

				const timeout = new Promise<never>((_resolve, reject) => {
					controller.signal.addEventListener(
						'abort',
						() =>
							reject(
								new Error(
									`job ${def.id} timed out after ${timeoutMs}ms`
								)
							),
						{ once: true }
					);
				});
				await Promise.race([def.handler(runOutcome.ctx), timeout]);
				return finish({
					kind: 'ok',
					durationMs: performance.now() - startedAt,
				});
			} catch (error) {
				log.error('job run failed', {
					error:
						error instanceof Error ? error.message : String(error),
				});
				span.recordError(error);
				deps.errorSink.capture(error, {
					entrypoint: 'job',
					requestId,
					route: def.id,
					traceId: span.traceId !== '' ? span.traceId : undefined,
					meta: { ...baseLabels, trigger },
				});
				return finish({
					kind: 'failed',
					durationMs: performance.now() - startedAt,
				});
			} finally {
				clearTimeout(timer);
				span.end();
				inFlight = false;
			}
		}

		return { id: def.id, schedule: def.schedule, run };
	};
}

export interface JobSchedulerConfig {
	readonly jobs: readonly JobInstance[];
	readonly deps: FactoryDeps;
}

export interface JobScheduler {
	/** Clears all timers and waits for in-flight runs to finish. */
	readonly stop: () => Promise<void>;
}

function msUntilNextTick(
	instance: JobInstance,
	now: Date
): { delayMs: number; scheduledFor: Date } {
	if ('cron' in instance.schedule) {
		const next = nextCronOccurrence(parseCron(instance.schedule.cron), now);
		return { delayMs: next.getTime() - now.getTime(), scheduledFor: next };
	}
	const next = new Date(now.getTime() + instance.schedule.everyMs);
	return { delayMs: instance.schedule.everyMs, scheduledFor: next };
}

/**
 * Timer-based scheduler binding JobInstances to their schedules — the
 * transport of the job entrypoint, as thin as mountRoutes/runConsumers are
 * for theirs. Re-arms after every tick (no drift accumulation for cron;
 * fixed-delay for intervals). No leader election: run one instance, or give
 * jobs an external lock before scaling out (documented in ADR-0014 terms).
 */
export function startJobScheduler(config: JobSchedulerConfig): JobScheduler {
	const { jobs, deps } = config;
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const running = new Set<Promise<unknown>>();
	let stopped = false;

	const arm = (instance: JobInstance): void => {
		if (stopped) return;
		const { delayMs, scheduledFor } = msUntilNextTick(
			instance,
			deps.clock.now()
		);
		const timer = setTimeout(() => {
			const run = instance
				.run('schedule', scheduledFor)
				.catch(() => undefined) // the frame already captured it
				.finally(() => {
					running.delete(run);
					arm(instance);
				});
			running.add(run);
		}, delayMs);
		timers.set(instance.id, timer);
	};

	const seen = new Set<string>();
	for (const instance of jobs) {
		if (seen.has(instance.id)) {
			throw new Error(`duplicate job id: ${instance.id}`);
		}
		seen.add(instance.id);
		arm(instance);
	}
	deps.log.info('job scheduler started', {
		jobs: jobs.map((instance) => instance.id),
	});

	return {
		stop: async () => {
			stopped = true;
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
			await Promise.allSettled([...running]);
		},
	};
}
