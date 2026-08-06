import pino, {
	type Logger as PinoLogger,
	type LoggerOptions as PinoLoggerOptions,
} from 'pino';
import prettyFactory from 'pino-pretty';
import { getActiveTraceContext } from './otel/context';
import { detectOtel, hasOtel } from './otel/detector';
import type { TraceContext } from './propagation/types';

export interface LoggerOptions {
	context?: string;
	level?: string;
	isDevelopment?: boolean;
	/** Enable automatic OTEL context extraction (default: true) */
	autoInjectOtel?: boolean;
	service?: {
		name: string;
		//version?: string;
		//environment?: string;
	};
}

export interface LogContext {
	traceId?: string;
	spanId?: string;
	tracestate?: string;
	requestId?: string;
	userId?: string;
	[key: string]: unknown;
}

export class Logger {
	private static pinoInstance: PinoLogger;
	private static otelInitialized = false;
	private static defaultOptions: LoggerOptions = {
		autoInjectOtel: true,
	};

	private context?: string;
	private logContext: LogContext = {};
	private autoInjectOtel: boolean;

	constructor(context?: string, options?: Partial<LoggerOptions>) {
		this.context = context;
		this.autoInjectOtel =
			options?.autoInjectOtel ??
			Logger.defaultOptions.autoInjectOtel ??
			true;

		if (!Logger.pinoInstance) {
			Logger.initializePino(Logger.defaultOptions);
		}

		// Initialize OTEL detection on first logger creation
		if (!Logger.otelInitialized) {
			Logger.otelInitialized = true;
			// Fire and forget - detection is async but we don't block
			detectOtel().catch(() => {
				// Silently ignore - OTEL just won't be available
			});
		}
	}

	static configure(options: LoggerOptions): void {
		Logger.defaultOptions = { ...Logger.defaultOptions, ...options };
		Logger.initializePino(Logger.defaultOptions);
	}

	private static initializePino(options: LoggerOptions): void {
		const isBrowserLike =
			typeof (globalThis as unknown as { window?: unknown }).window !==
				'undefined' ||
			typeof (globalThis as unknown as { EdgeRuntime?: unknown })
				.EdgeRuntime !== 'undefined';

		// Resolve env vars at call time, not at class definition time.
		// This ensures dotenv/env validation has run before we read process.env.
		const level = options.level || process.env.LOG_LEVEL || 'info';
		const isDevelopment =
			options.isDevelopment ?? process.env.NODE_ENV !== 'production';
		const serviceName =
			options.service?.name ||
			process.env.SERVICE_NAME ||
			'unknown-service';
		// const serviceVersion =
		// 	options.service?.version || process.env.SERVICE_VERSION || '0.0.0';
		// const serviceEnvironment =
		// 	options.service?.environment ||
		// 	process.env.NODE_ENV ||
		// 	'development';

		const isDev = isDevelopment && !isBrowserLike;

		const pinoConfig: PinoLoggerOptions = {
			level,

			// Better Stack expects 'dt' for timestamp in ISO8601
			timestamp: () => `,"dt":"${new Date().toISOString()}"`,

			// Service metadata in every log line
			base: {
				service: serviceName,
				// version: serviceVersion,
				// env: serviceEnvironment,
			},

			formatters: {
				level: (label) => ({ level: label }),
				log: (obj) => {
					// Flatten error objects for better indexing
					if (obj.err instanceof Error) {
						return {
							...obj,
							error: {
								message: obj.err.message,
								name: obj.err.name,
								stack: obj.err.stack,
							},
							err: undefined,
						};
					}
					return obj;
				},
			},
		};

		// Pretty print only in development. Use an in-process pino-pretty
		// stream instead of a worker-thread transport: bundled server runtimes
		// (e.g. Next.js) can't resolve the transport target in the worker,
		// which throws "unable to determine transport target for pino-pretty".
		if (isDev) {
			const prettyStream = prettyFactory({
				colorize: true,
				translateTime: 'SYS:standard',
				ignore: 'pid,hostname,service,version,env',
				messageFormat: '{context} {msg}',
				errorLikeObjectKeys: ['err', 'error'],
			});
			Logger.pinoInstance = pino(pinoConfig, prettyStream);
		} else {
			Logger.pinoInstance = pino(pinoConfig);
		}
	}

	/**
	 * Set trace context for correlation with distributed traces
	 * Call this at the start of each request with IDs from OTEL context
	 */
	setTraceContext(traceId: string, spanId?: string): this {
		this.logContext.traceId = traceId;
		this.logContext.spanId = spanId;
		return this;
	}

	/**
	 * Set trace context from W3C TraceContext object
	 */
	setTraceContextFromW3C(context: TraceContext | null): this {
		if (!context) return this;
		this.logContext.traceId = context.traceId;
		this.logContext.spanId = context.spanId;
		if (context.tracestate) {
			this.logContext.tracestate = context.tracestate;
		}
		return this;
	}

	/**
	 * Clear trace context (useful between requests)
	 */
	clearTraceContext(): this {
		delete this.logContext.traceId;
		delete this.logContext.spanId;
		delete this.logContext.tracestate;
		return this;
	}

	/**
	 * Get current trace context for propagation
	 */
	getTraceContext(): TraceContext | null {
		if (!this.logContext.traceId) {
			// Try to get from OTEL if auto-inject is enabled
			if (this.autoInjectOtel && hasOtel()) {
				return getActiveTraceContext();
			}
			return null;
		}

		return {
			traceId: this.logContext.traceId,
			spanId: this.logContext.spanId || '',
			sampled: true,
			tracestate: this.logContext.tracestate,
		};
	}

	/**
	 * Set request-specific context
	 */
	setRequestContext(requestId: string, userId?: string): this {
		this.logContext.requestId = requestId;
		this.logContext.userId = userId;
		return this;
	}

	/**
	 * Add arbitrary context that will be included in all subsequent logs
	 */
	addContext(ctx: Record<string, unknown>): this {
		this.logContext = { ...this.logContext, ...ctx };
		return this;
	}

	/**
	 * Create a child logger with additional bound context
	 */
	child(bindings: Record<string, unknown>): Logger {
		const childLogger = new Logger(this.context, {
			autoInjectOtel: this.autoInjectOtel,
		});
		childLogger.logContext = { ...this.logContext, ...bindings };
		return childLogger;
	}

	private getLogger(): PinoLogger {
		const bindings: Record<string, unknown> = {
			...this.logContext,
		};

		if (this.context) {
			bindings.context = this.context;
		}

		// Auto-inject from OTEL if enabled and no manual context set
		if (this.autoInjectOtel && !this.logContext.traceId && hasOtel()) {
			const otelCtx = getActiveTraceContext();
			if (otelCtx) {
				bindings.trace_id = otelCtx.traceId;
				bindings.span_id = otelCtx.spanId;
			}
		} else {
			// Use manually set context
			if (this.logContext.traceId) {
				bindings.trace_id = this.logContext.traceId;
			}
			if (this.logContext.spanId) {
				bindings.span_id = this.logContext.spanId;
			}
		}

		return Logger.pinoInstance.child(bindings);
	}

	info(message: string, data?: Record<string, unknown>): void {
		this.getLogger().info(data ?? {}, message);
	}

	error(
		message: string,
		error?: unknown,
		data?: Record<string, unknown>
	): void {
		const errorObj = this.normalizeError(error);
		this.getLogger().error({ err: errorObj, ...data }, message);
	}

	warn(message: string, data?: Record<string, unknown>): void {
		this.getLogger().warn(data ?? {}, message);
	}

	debug(message: string, data?: Record<string, unknown>): void {
		this.getLogger().debug(data ?? {}, message);
	}

	fatal(
		message: string,
		error?: unknown,
		data?: Record<string, unknown>
	): void {
		const errorObj = this.normalizeError(error);
		this.getLogger().fatal({ err: errorObj, ...data }, message);
	}

	private normalizeError(error: unknown): Error | undefined {
		if (error === undefined || error === null) return undefined;
		if (error instanceof Error) return error;
		if (typeof error === 'string') return new Error(error);
		return new Error(String(error));
	}

	// Utility for timing operations
	startTimer(): () => number {
		const start = performance.now();
		return () => Math.round(performance.now() - start);
	}

	static flush(): Promise<void> {
		return new Promise((resolve) => {
			if (Logger.pinoInstance) {
				Logger.pinoInstance.flush();
			}
			// Give async transports time to flush
			setTimeout(resolve, 100);
		});
	}
}

// Factory function for easier usage
export function createLogger(context: string): Logger {
	return new Logger(context);
}
