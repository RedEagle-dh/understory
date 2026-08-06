import type { EdenApp } from '../eden';
import type { RouteInstance } from '../route';
import type { FrameworkModule } from './module';

/** The route tuple a module contributes (empty if it contributes none). */
type RoutesOf<M> = M extends FrameworkModule<infer _Env, infer Routes>
	? Routes
	: readonly [];

/** Concatenate a tuple of route tuples into one flat route tuple. */
type ConcatRoutes<Groups extends readonly (readonly RouteInstance[])[]> =
	Groups extends readonly [
		infer Head extends readonly RouteInstance[],
		...infer Rest extends readonly (readonly RouteInstance[])[],
	]
		? readonly [...Head, ...ConcatRoutes<Rest>]
		: readonly [];

/**
 * Derives the Eden treaty app type from the manifest's module tuple — the
 * single source of truth for the client type. Modules are bounded as
 * `FrameworkModule<never>` (the `Env` param is contravariant, so any concrete
 * `FrameworkModule<AppEnv, R>` is assignable) purely so this util accepts the
 * whole tuple.
 *
 *   export type AppEden = ManifestEden<typeof manifest.modules>;
 *   const api = treaty<AppEden>(baseUrl);
 */
export type ManifestEden<Mods extends readonly FrameworkModule<never>[]> =
	EdenApp<
		ConcatRoutes<{ readonly [K in keyof Mods]: RoutesOf<Mods[K]> }>
	>;
