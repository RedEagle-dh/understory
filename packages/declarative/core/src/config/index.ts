/**
 * The source-of-truth config the CLI reads to generate `src/generated/manifest.ts`.
 * Hand-edited (or edited by `dcl add`/`dcl remove`); never imported at runtime.
 */

export interface ModuleConfigEntry {
	/**
	 * The module's import specifier. A bare package (`@declarativejs/module-audit`)
	 * or a local path (`./modules/moderation`) for the app's own domain modules.
	 */
	readonly package: string;
	/** The named export that is the module factory. Default: `<name>Module`. */
	readonly export?: string;
	/** Options passed to the module factory, emitted verbatim into the manifest. */
	readonly options?: Record<string, unknown>;
}

export interface TelemetryConfigEntry {
	readonly enabled: boolean;
	readonly package: string;
	readonly export?: string;
	readonly options?: Record<string, unknown>;
}

export interface FrameworkConfig {
	/** Import path to the hand-written environment module exporting `createEnvironment`. */
	readonly environment: string;
	/** Enabled feature modules, keyed by a stable name (drives import aliasing + ordering). */
	readonly modules: Record<string, ModuleConfigEntry>;
	/**
	 * Telemetry providers (observability, error-tracking, access-log, ...), keyed
	 * by a stable name. An entry with `enabled: false` is omitted from the
	 * manifest entirely — its package is never imported.
	 */
	readonly telemetry?: Record<string, TelemetryConfigEntry>;
}

export function defineConfig(config: FrameworkConfig): FrameworkConfig {
	return config;
}
