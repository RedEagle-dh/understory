import type { LoggerPort } from './ports';

/**
 * Graceful-shutdown lifecycle (ADR-0014 #5). The drain order is encoded HERE,
 * once, as named phases — participants (transport, v1 legacy services, the v2
 * composition root) only fill the slots they own:
 *
 *   1. rejectNewRequests    — flip readiness, stop schedulers/cron: no new work
 *   2. finishRunningHandlers — wait for in-flight entrypoints to complete
 *   3. closeConsumers        — stop consuming broker messages (acks close)
 *   4. disconnectClients     — actively close ws clients with a resume hint
 *   5. flushOutbox           — publish remaining committed outbox rows
 *   6. dispose               — release resources (pools, breakers, telemetry)
 *
 * Every slot call is bounded by a timeout and error-isolated: shutdown always
 * runs to completion — a hanging step is logged and skipped, never fatal.
 */
export interface DrainSlots {
	rejectNewRequests?(): void | Promise<void>;
	finishRunningHandlers?(): void | Promise<void>;
	closeConsumers?(): void | Promise<void>;
	disconnectClients?(): void | Promise<void>;
	flushOutbox?(): void | Promise<void>;
	dispose?(): void | Promise<void>;
}

const PHASES = [
	'rejectNewRequests',
	'finishRunningHandlers',
	'closeConsumers',
	'disconnectClients',
	'flushOutbox',
	'dispose',
] as const satisfies readonly (keyof DrainSlots)[];

export interface ShutdownLifecycle {
	/**
	 * Runs all phases in order across all participants. Idempotent — repeated
	 * calls (SIGINT + SIGTERM) await the same run.
	 */
	shutdown(): Promise<void>;
	/** True from the first shutdown() call on — readiness must report 503. */
	isDraining(): boolean;
}

export interface ShutdownLifecycleOptions {
	readonly participants: readonly DrainSlots[];
	readonly log: LoggerPort;
	/** Budget per slot call before it is abandoned (default 10s). */
	readonly stepTimeoutMs?: number;
}

const STEP_TIMEOUT_MS = 10_000;

export function createShutdownLifecycle(
	options: ShutdownLifecycleOptions
): ShutdownLifecycle {
	const { participants, log } = options;
	const stepTimeoutMs = options.stepTimeoutMs ?? STEP_TIMEOUT_MS;
	let run: Promise<void> | null = null;

	const bounded = async (
		phase: string,
		work: Promise<void>
	): Promise<void> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new Error(`step timed out after ${stepTimeoutMs}ms`)
					),
				stepTimeoutMs
			);
		});
		try {
			await Promise.race([work, timeout]);
		} catch (error) {
			log.error('shutdown step failed — continuing drain', {
				phase,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			clearTimeout(timer);
		}
	};

	const drain = async (): Promise<void> => {
		const startedAt = performance.now();
		for (const phase of PHASES) {
			const phaseStartedAt = performance.now();
			let ran = 0;
			for (const participant of participants) {
				const slot = participant[phase];
				if (slot === undefined) continue;
				ran += 1;
				await bounded(
					phase,
					Promise.resolve().then(() => slot.call(participant))
				);
			}
			if (ran > 0) {
				log.info('shutdown phase complete', {
					phase,
					participants: ran,
					durationMs: Math.round(performance.now() - phaseStartedAt),
				});
			}
		}
		log.info('graceful shutdown complete', {
			durationMs: Math.round(performance.now() - startedAt),
		});
	};

	return {
		shutdown() {
			run ??= drain();
			return run;
		},
		isDraining() {
			return run !== null;
		},
	};
}
