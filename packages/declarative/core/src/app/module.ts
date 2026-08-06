import type { TSchema } from '@sinclair/typebox';
import type { ConsumerInstance } from '../consumer';
import type { JobInstance } from '../job';
import type { DrainSlots } from '../lifecycle';
import type { FactoryDeps } from '../ports';
import type { RouteInstance } from '../route';
import type { WsHub, WsTopicInstance } from '../ws';

/** A consumer plus the broker stream it binds to (replaces the inline pair in the composition root). */
export interface ModuleConsumerBinding {
	readonly stream: string;
	readonly consumer: ConsumerInstance;
}

/**
 * Everything a module may contribute to the app. `routes` keeps its precise
 * tuple type so the Eden client type can be derived from the module list — no
 * second hand-maintained tuple.
 */
export interface ModuleContributions<
	Routes extends readonly RouteInstance[] = readonly RouteInstance[],
> {
	readonly routes?: Routes;
	readonly consumers?: readonly ModuleConsumerBinding[];
	readonly jobs?: readonly JobInstance[];
	readonly wsTopics?: readonly WsTopicInstance<TSchema>[];
	readonly drain?: DrainSlots;
}

/**
 * The base an app environment must satisfy for `createApp` to orchestrate it.
 * The hand-written `environment.ts` returns a richer type (surface factories,
 * domain ports) that also extends this — modules require only the slice they
 * name, which is what keeps each module an independently installable package.
 */
export interface AppEnvironment {
	/** The assembled ports, built via `assembleDeps` — used for jobs and shutdown logging. */
	readonly deps: FactoryDeps;
	/** Present when the app exposes a WebSocket surface; `createApp` mounts it. */
	readonly hub?: WsHub;
	/** The environment's own drain slots (pools, breakers, relay). */
	readonly drain?: DrainSlots;
	/** Binds module consumers to the broker at startup (the environment owns the broker runtime). */
	readonly startConsumers?: (
		bindings: readonly ModuleConsumerBinding[]
	) => Promise<void>;
	/** Readiness probe, surfaced by the app's transport on /ready. */
	readonly ready?: () => Promise<unknown>;
}

/**
 * The uniform module contract. A module is a pure function of the app
 * environment: it names the surface factories and domain ports it needs as
 * fields of `Env`, and returns what it contributes. `Routes` is inferred from
 * `build`'s return so it flows into the Eden client type.
 */
export interface FrameworkModule<
	Env,
	Routes extends readonly RouteInstance[] = readonly RouteInstance[],
> {
	readonly id: string;
	readonly build: (env: Env) => ModuleContributions<Routes>;
}

export function defineModule<Env, Routes extends readonly RouteInstance[]>(
	module: FrameworkModule<Env, Routes>
): FrameworkModule<Env, Routes> {
	return module;
}
