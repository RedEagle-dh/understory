import type { AppEnvironment, FrameworkModule } from './module';
import type { ObservabilityPorts, TelemetryProvider } from './observability';

/** What `createApp` hands the hand-written `createEnvironment`. */
export interface EnvironmentInput {
	/** Merged telemetry ports from all enabled providers; gaps are core no-ops. */
	readonly telemetry?: ObservabilityPorts;
}

/**
 * The generated manifest's shape — the single source of truth for the app.
 * `modules` is a `const` tuple so its element types survive into
 * `ManifestEden`. `telemetry` lists the enabled telemetry providers (each an
 * independently installable package). `createEnvironment` is the hand-written
 * seam that builds the concrete adapters and static pipelines.
 */
export interface ManifestSpec<
	Env extends AppEnvironment,
	Mods extends readonly FrameworkModule<Env>[],
> {
	readonly createEnvironment: (input: EnvironmentInput) => Env;
	readonly telemetry?: readonly TelemetryProvider[];
	readonly modules: Mods;
}

export function defineManifest<
	Env extends AppEnvironment,
	const Mods extends readonly FrameworkModule<Env>[],
>(spec: ManifestSpec<Env, Mods>): ManifestSpec<Env, Mods> {
	return spec;
}
