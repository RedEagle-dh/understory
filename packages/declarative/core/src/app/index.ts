export { defineModule } from './module';
export type {
	AppEnvironment,
	FrameworkModule,
	ModuleContributions,
	ModuleConsumerBinding,
} from './module';

export { defineManifest } from './manifest';
export type { EnvironmentInput, ManifestSpec } from './manifest';

export { createApp } from './create-app';
export type { CreateAppOptions } from './create-app';

export type { ManifestEden } from './eden';

export {
	assembleDeps,
	consoleLogger,
	logErrorSink,
	noopMetrics,
} from './defaults';
export type { AssembleDepsInput } from './defaults';

export type { ObservabilityPorts, TelemetryProvider } from './observability';
