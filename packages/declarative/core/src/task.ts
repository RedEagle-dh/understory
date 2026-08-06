import { type StaticDecode, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ValidationFailedError } from './errors';
import type { FactoryDeps, LoggerPort } from './ports';

/**
 * `task()` — the entrypoint for long-running operations (ADR-0014 #2):
 * channel transfer, GDPR deletion, data export. This is the Phase-0 slice of
 * that design: persisted run state + progress, cancellation, the same
 * span/metrics/error-boundary frame as every other entrypoint, and a status
 * surface via the store. The NATS work queue and crash resumability arrive
 * with the full ADR — execution here is in-process, fired by `start()`.
 *
 * Policy is NOT re-run here: starting a task from a route is the policy
 * moment (the route pipeline minted the TenantContext), and the typed `Scope`
 * carries that capability into the handler — same principle as handlers
 * receiving `ctx.tenant`, not a db.
 */

export interface TaskProgress {
	readonly current: number;
	readonly total?: number;
	readonly message?: string;
}

export type TaskRunStatus =
	| 'pending'
	| 'running'
	| 'done'
	| 'failed'
	| 'cancelled';

/**
 * The persisted view of one run. Attribution strings only — the framework
 * cannot name domain types (ADR-0012); the typed Scope lives in memory, never
 * in the store.
 */
export interface TaskRunRecord {
	readonly runId: string;
	readonly taskId: string;
	readonly status: TaskRunStatus;
	readonly progress: TaskProgress | null;
	readonly input: unknown;
	readonly result?: unknown;
	/** Public error code (declared TypedErrors expose theirs; bugs say INTERNAL). */
	readonly error?: string;
	readonly tenantId?: string;
	readonly actorId?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TaskRunPatch {
	readonly status?: TaskRunStatus;
	readonly progress?: TaskProgress;
	readonly result?: unknown;
	readonly error?: string;
}

/**
 * Run-state store. The durable Postgres adapter lands with the full ADR-0014
 * design; `createInMemoryTaskStore` covers tests and the sandbox slice.
 */
export interface TaskStorePort {
	create(record: TaskRunRecord): Promise<void>;
	update(
		runId: string,
		patch: TaskRunPatch,
		updatedAt: string
	): Promise<TaskRunRecord | null>;
	get(runId: string): Promise<TaskRunRecord | null>;
}

export type TaskHandlerContext<
	Input extends TSchema,
	Scope extends object,
> = Scope & {
	readonly runId: string;
	readonly taskId: string;
	readonly input: StaticDecode<Input>;
	readonly log: LoggerPort;
	readonly signal: AbortSignal;
	readonly traceparent: string;
	/** Persists progress and notifies the definition's onUpdate observer. */
	readonly reportProgress: (progress: TaskProgress) => Promise<void>;
};

export interface TaskShape<
	Input extends TSchema,
	Scope extends object,
	Result,
> {
	readonly id: string;
	readonly input: Input;
	/** Long frame by default — tasks are the opposite of request-shaped. */
	readonly timeoutMs?: number;
	/**
	 * Observer for every persisted state change (progress, status). The
	 * composition wires live surfaces here (e.g. publish to a ws topic).
	 * Fire-and-forget: it must never throw into the run.
	 */
	readonly onUpdate?: (record: TaskRunRecord, scope: Scope) => void;
	readonly handler: (
		ctx: TaskHandlerContext<Input, Scope>
	) => Promise<Result>;
}

export interface StartTaskOptions<Scope extends object> {
	/** Typed capability context the start route resolved (e.g. { tenant, actor }). */
	readonly scope: Scope;
	/** Attribution strings persisted on the run for status-read authorization. */
	readonly tenantId?: string;
	readonly actorId?: string;
	/** Continue the starting request's trace. */
	readonly traceparent?: string;
}

export interface TaskInstance<Input extends TSchema, Scope extends object> {
	readonly id: string;
	readonly input: Input;
	/** Validates input, persists a pending run and fires execution. Returns immediately. */
	readonly start: (
		rawInput: unknown,
		options: StartTaskOptions<Scope>
	) => Promise<{ readonly runId: string }>;
	/** Aborts a running run. False when the run is not in flight here. */
	readonly cancel: (runId: string) => boolean;
	readonly get: (runId: string) => Promise<TaskRunRecord | null>;
}

export interface TaskFactoryConfig {
	readonly deps: FactoryDeps;
	readonly store: TaskStorePort;
	readonly defaultTimeoutMs?: number;
}

export type TaskFactory = <Input extends TSchema, Scope extends object, Result>(
	def: TaskShape<Input, Scope, Result>
) => TaskInstance<Input, Scope>;

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000;

class TaskAbortedError extends Error {
	constructor(taskId: string, runId: string) {
		super(`task ${taskId} run ${runId} aborted`);
	}
}

export function createTaskFactory(config: TaskFactoryConfig): TaskFactory {
	const { deps, store } = config;

	return function task<Input extends TSchema, Scope extends object, Result>(
		def: TaskShape<Input, Scope, Result>
	): TaskInstance<Input, Scope> {
		const timeoutMs =
			def.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
		const baseLabels = { task: def.id };
		const inFlight = new Map<string, AbortController>();

		const notify = (record: TaskRunRecord, scope: Scope): void => {
			try {
				def.onUpdate?.(record, scope);
			} catch (error) {
				deps.log.warn('task onUpdate observer threw — ignored', {
					task: def.id,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		};

		async function persist(
			runId: string,
			patch: TaskRunPatch,
			scope: Scope
		): Promise<void> {
			const record = await store.update(
				runId,
				patch,
				deps.clock.now().toISOString()
			);
			if (record !== null) notify(record, scope);
		}

		async function execute(
			runId: string,
			input: StaticDecode<Input>,
			options: StartTaskOptions<Scope>
		): Promise<void> {
			const controller = new AbortController();
			inFlight.set(runId, controller);
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			const span = deps.tracer.startSpan(`task ${def.id}`, {
				remoteParent: options.traceparent,
				attributes: { 'task.id': def.id, 'task.run_id': runId },
			});
			const log = deps.log.child({
				task: def.id,
				runId,
				...(span.traceId !== '' ? { traceId: span.traceId } : {}),
			});
			const startedAt = performance.now();

			const finish = (result: 'done' | 'failed' | 'cancelled'): void => {
				deps.metrics.observe(
					'task_run_duration_ms',
					performance.now() - startedAt,
					baseLabels
				);
				deps.metrics.increment('task_runs_total', {
					...baseLabels,
					result,
				});
				span.setStatus(result === 'done' ? 'ok' : 'error');
			};

			try {
				await persist(runId, { status: 'running' }, options.scope);
				const handlerCtx: TaskHandlerContext<Input, Scope> =
					Object.assign({}, options.scope, {
						runId,
						taskId: def.id,
						input,
						log,
						signal: controller.signal,
						traceparent: span.traceparent,
						reportProgress: (progress: TaskProgress) =>
							persist(runId, { progress }, options.scope),
					});
				const timeout = new Promise<never>((_resolve, reject) => {
					controller.signal.addEventListener(
						'abort',
						() => reject(new TaskAbortedError(def.id, runId)),
						{ once: true }
					);
				});
				const result = await Promise.race([
					def.handler(handlerCtx),
					timeout,
				]);
				await persist(runId, { status: 'done', result }, options.scope);
				finish('done');
			} catch (error) {
				// An abort is a cancellation (or the timeout), not a bug.
				if (
					controller.signal.aborted ||
					error instanceof TaskAbortedError
				) {
					log.info('task run cancelled/timed out');
					await persist(
						runId,
						{ status: 'cancelled', error: 'CANCELLED' },
						options.scope
					);
					finish('cancelled');
					return;
				}
				log.error('task run failed', {
					error:
						error instanceof Error ? error.message : String(error),
				});
				span.recordError(error);
				deps.errorSink.capture(error, {
					entrypoint: 'task',
					requestId: runId,
					route: def.id,
					traceId: span.traceId !== '' ? span.traceId : undefined,
					tenantId: options.tenantId,
					actorId: options.actorId,
					meta: baseLabels,
				});
				await persist(
					runId,
					{ status: 'failed', error: 'INTERNAL' },
					options.scope
				);
				finish('failed');
			} finally {
				clearTimeout(timer);
				span.end();
				inFlight.delete(runId);
			}
		}

		return {
			id: def.id,
			input: def.input,
			start: async (rawInput, options) => {
				const input = ((): StaticDecode<Input> => {
					try {
						return Value.Parse(def.input, rawInput);
					} catch (error) {
						const detail =
							error instanceof Error
								? error.message
								: String(error);
						throw new ValidationFailedError([`input: ${detail}`]);
					}
				})();
				const runId = deps.ids.id();
				const now = deps.clock.now().toISOString();
				const record: TaskRunRecord = {
					runId,
					taskId: def.id,
					status: 'pending',
					progress: null,
					input,
					tenantId: options.tenantId,
					actorId: options.actorId,
					createdAt: now,
					updatedAt: now,
				};
				await store.create(record);
				notify(record, options.scope);
				deps.metrics.increment('task_runs_started_total', baseLabels);
				// Fire-and-return: the run outlives the starting request. The
				// error boundary inside execute() owns every failure path.
				void execute(runId, input, options);
				return { runId };
			},
			cancel: (runId) => {
				const controller = inFlight.get(runId);
				if (controller === undefined) return false;
				controller.abort();
				return true;
			},
			get: (runId) => store.get(runId),
		};
	};
}

/**
 * In-memory TaskStorePort: tests and the single-instance sandbox slice. Runs
 * die with the process — the durable store is part of ADR-0014 #2's full
 * design (resumability needs it anyway).
 */
export function createInMemoryTaskStore(): TaskStorePort {
	const runs = new Map<string, TaskRunRecord>();
	return {
		create: async (record) => {
			runs.set(record.runId, record);
		},
		update: async (runId, patch, updatedAt) => {
			const existing = runs.get(runId);
			if (existing === undefined) return null;
			const next: TaskRunRecord = {
				...existing,
				...(patch.status !== undefined ? { status: patch.status } : {}),
				...(patch.progress !== undefined
					? { progress: patch.progress }
					: {}),
				...(patch.result !== undefined ? { result: patch.result } : {}),
				...(patch.error !== undefined ? { error: patch.error } : {}),
				updatedAt,
			};
			runs.set(runId, next);
			return next;
		},
		get: async (runId) => runs.get(runId) ?? null,
	};
}
