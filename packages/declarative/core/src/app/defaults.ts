import type {
	ClockPort,
	ErrorSinkPort,
	FactoryDeps,
	IdGeneratorPort,
	LoggerPort,
	MetricsPort,
} from '../ports';
import { noopTracer } from '../tracing';
import type { ObservabilityPorts } from './observability';

/** Metrics sink that drops everything — the fallback when no module is installed. */
export const noopMetrics: MetricsPort = {
	increment() {},
	observe() {},
};

/**
 * ErrorSink that logs instead of shipping to a tracker — the fallback when the
 * error-tracking module is not installed. Every undeclared error still surfaces
 * (in the logs), just without the tracker's grouping/deep-links.
 */
export function logErrorSink(log: LoggerPort): ErrorSinkPort {
	return {
		capture(error, context) {
			log.error('unhandled entrypoint error (no error tracker installed)', {
				error:
					error instanceof Error
						? (error.stack ?? error.message)
						: String(error),
				...context,
			});
		},
	};
}

function writeLine(
	stream: 'out' | 'err',
	level: string,
	message: string,
	bindings: Record<string, unknown>,
	fields: Record<string, unknown> | undefined
): void {
	const line = `${JSON.stringify({
		level,
		time: new Date().toISOString(),
		message,
		...bindings,
		...fields,
	})}\n`;
	if (stream === 'err') process.stderr.write(line);
	else process.stdout.write(line);
}

function createConsoleLogger(bindings: Record<string, unknown>): LoggerPort {
	return {
		debug: (message, fields) =>
			writeLine('out', 'debug', message, bindings, fields),
		info: (message, fields) =>
			writeLine('out', 'info', message, bindings, fields),
		warn: (message, fields) =>
			writeLine('err', 'warn', message, bindings, fields),
		error: (message, fields) =>
			writeLine('err', 'error', message, bindings, fields),
		child: (childBindings) =>
			createConsoleLogger({ ...bindings, ...childBindings }),
	};
}

/**
 * The core's built-in structured JSON logger — used when the app does not wire
 * a richer one (e.g. pino via @declarativejs/logger). Keeps the framework usable
 * with zero packages installed.
 */
export const consoleLogger: LoggerPort = createConsoleLogger({});

export interface AssembleDepsInput {
	/** The app's logger. Defaults to the core JSON console logger. */
	readonly log?: LoggerPort;
	readonly clock?: ClockPort;
	readonly ids?: IdGeneratorPort;
	/** Telemetry ports from the observability module, if installed. */
	readonly telemetry?: ObservabilityPorts;
}

/**
 * Builds the `FactoryDeps` every entrypoint factory needs. Core ports
 * (log/clock/ids) get sensible defaults; telemetry ports come from the
 * observability module when installed, else framework no-ops. The factory call
 * sites (`deps.tracer.startSpan`, `deps.metrics.observe`, ...) stay
 * unconditional — only the backend behind each port is swapped.
 */
export function assembleDeps(input: AssembleDepsInput = {}): FactoryDeps {
	const log = input.log ?? consoleLogger;
	const clock: ClockPort = input.clock ?? { now: () => new Date() };
	const ids: IdGeneratorPort = input.ids ?? {
		requestId: () => crypto.randomUUID(),
		id: () => crypto.randomUUID(),
	};
	const telemetry = input.telemetry;
	return {
		log,
		clock,
		ids,
		tracer: telemetry?.tracer ?? noopTracer,
		metrics: telemetry?.metrics ?? noopMetrics,
		errorSink: telemetry?.errorSink ?? logErrorSink(log),
		...(telemetry?.accessLog !== undefined
			? { accessLog: telemetry.accessLog }
			: {}),
	};
}
