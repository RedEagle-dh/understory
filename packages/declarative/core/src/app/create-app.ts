import { Elysia } from 'elysia';
import { mountRoutes } from '../elysia';
import { type JobScheduler, startJobScheduler } from '../job';
import { createShutdownLifecycle, type DrainSlots } from '../lifecycle';
import type { JobInstance } from '../job';
import type { RouteInstance } from '../route';
import { mountWsHub } from '../ws-elysia';
import { consoleLogger } from './defaults';
import type { ManifestSpec } from './manifest';
import type {
	AppEnvironment,
	FrameworkModule,
	ModuleConsumerBinding,
} from './module';
import type { ObservabilityPorts } from './observability';

export interface CreateAppOptions {
	/** Trust `X-Forwarded-For` for the client IP — only behind a sanitizing proxy. */
	readonly trustProxy?: boolean;
	/** WebSocket endpoint path when the environment exposes a hub. Default `/ws`. */
	readonly wsPath?: string;
	/**
	 * When true (default), `createApp` registers SIGINT/SIGTERM handlers that
	 * run the drain lifecycle then exit. Set false to embed under a host that
	 * owns process signals and drives shutdown itself.
	 */
	readonly managedLifecycle?: boolean;
}

/** Merge each provider's ports (later provider wins per port); gaps stay undefined for no-op fallback. */
function mergeTelemetry(
	portsList: readonly ObservabilityPorts[]
): ObservabilityPorts {
	return portsList.reduce<ObservabilityPorts>(
		(acc, ports) => ({
			...acc,
			...(ports.tracer !== undefined ? { tracer: ports.tracer } : {}),
			...(ports.metrics !== undefined ? { metrics: ports.metrics } : {}),
			...(ports.errorSink !== undefined
				? { errorSink: ports.errorSink }
				: {}),
			...(ports.accessLog !== undefined
				? { accessLog: ports.accessLog }
				: {}),
		}),
		{}
	);
}

/**
 * The app builder. Consumes a generated manifest and does, uniformly, what a
 * hand-written composition root + index.ts do: resolve+merge telemetry, build
 * the environment, run every module, collect and mount routes, mount the ws
 * hub, schedule jobs, bind consumers, and merge drain slots into one shutdown
 * lifecycle. Returns an Elysia plugin — `index.ts` only ever does `.use()`.
 * Elysia stays transport-only throughout.
 */
export function createApp<
	Env extends AppEnvironment,
	Mods extends readonly FrameworkModule<Env>[],
>(manifest: ManifestSpec<Env, Mods>, options: CreateAppOptions = {}): Elysia {
	const providers = manifest.telemetry ?? [];
	const resolved = providers.map((provider) => ({
		ports: provider.init({ log: consoleLogger }),
		drain: provider.drain,
	}));
	const telemetry =
		resolved.length > 0
			? mergeTelemetry(resolved.map((entry) => entry.ports))
			: undefined;

	const env = manifest.createEnvironment({ telemetry });
	const { deps } = env;

	const contributions = manifest.modules.map((module) => module.build(env));
	const routes: RouteInstance[] = contributions.flatMap((c) =>
		c.routes !== undefined ? [...c.routes] : []
	);
	const jobs: JobInstance[] = contributions.flatMap((c) =>
		c.jobs !== undefined ? [...c.jobs] : []
	);
	const consumers: ModuleConsumerBinding[] = contributions.flatMap((c) =>
		c.consumers !== undefined ? [...c.consumers] : []
	);
	const drains: DrainSlots[] = [
		...contributions.flatMap((c) => (c.drain !== undefined ? [c.drain] : [])),
		...(env.drain !== undefined ? [env.drain] : []),
		...resolved.flatMap((entry) =>
			entry.drain !== undefined ? [entry.drain] : []
		),
	];

	const plugin = new Elysia();
	mountRoutes(plugin, routes, { trustProxy: options.trustProxy });
	if (env.hub !== undefined) {
		mountWsHub(plugin, env.hub, {
			path: options.wsPath ?? '/ws',
			trustProxy: options.trustProxy,
		});
	}

	const lifecycle = createShutdownLifecycle({
		participants: drains,
		log: deps.log,
	});

	let scheduler: JobScheduler | null = null;
	plugin.onStart(async () => {
		if (jobs.length > 0) scheduler = startJobScheduler({ jobs, deps });
		if (env.startConsumers !== undefined && consumers.length > 0) {
			await env.startConsumers(consumers);
		}
	});
	plugin.onStop(async () => {
		if (scheduler !== null) await scheduler.stop();
		await lifecycle.shutdown();
	});

	if (options.managedLifecycle ?? true) {
		const handle = (): void => {
			void lifecycle.shutdown().then(() => process.exit(0));
		};
		process.once('SIGINT', handle);
		process.once('SIGTERM', handle);
	}

	return plugin;
}
