import type { DrainSlots } from '../lifecycle';
import type {
	AccessLogPort,
	ErrorSinkPort,
	LoggerPort,
	MetricsPort,
	TracerPort,
} from '../ports';

/**
 * The telemetry ports an observability module supplies. All optional: a module
 * may provide only what it implements (e.g. metrics without tracing) and
 * `assembleDeps` fills every gap with a framework no-op. This is the seam that
 * makes observability install-time optional — when no module is present the
 * framework runs on no-ops, never on a hard import of a telemetry package.
 */
export interface ObservabilityPorts {
	readonly tracer?: TracerPort;
	readonly metrics?: MetricsPort;
	readonly errorSink?: ErrorSinkPort;
	readonly accessLog?: AccessLogPort;
}

/**
 * A configured telemetry provider (observability, error tracking, access-log
 * sink, ...). `init` boots its backend once at startup and returns the ports it
 * implements; `drain` releases them during graceful shutdown. The manifest
 * carries a list of these; `createApp` merges their ports (later wins per port)
 * into the single `ObservabilityPorts` handed to the environment. Each provider
 * is its own installable package — the only place it is ever imported is the
 * generated manifest, and only when enabled.
 */
export interface TelemetryProvider {
	readonly id: string;
	readonly init: (ctx: { readonly log: LoggerPort }) => ObservabilityPorts;
	readonly drain?: DrainSlots;
}
