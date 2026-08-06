// Minimal latency repro: pure declarative framework, no db/auth/env imports.
import { createApp, defineManifest, defineModule } from '@declarativejs/core/app';
import {
	createRateLimitStage,
	createRouteFactory,
	type FactoryDeps,
	pipeline,
	type RequestContext,
	t,
} from '@declarativejs/core';
import {
	assembleDeps,
	consoleLogger,
	type EnvironmentInput,
} from '@declarativejs/core/app';
import { createMemoryRateLimiter } from '@declarativejs/module-rate-limit';
import { observabilityModule } from '@declarativejs/module-observability';
import { Elysia } from 'elysia';

function makeSurface(deps: FactoryDeps) {
	const limiter = createMemoryRateLimiter();
	return createRouteFactory({
		surface: 'public',
		pipeline: pipeline<RequestContext>().use(
			createRateLimitStage(
				limiter,
				{ anon: { limit: 60, windowSeconds: 60, scope: 'ip' } } as const,
				() => ({})
			)
		),
		deps,
	});
}

function pingModule() {
	return defineModule({
		id: 'ping',
		build: (env: { surfaces: { public: ReturnType<typeof makeSurface> } }) => ({
			routes: [
				env.surfaces.public({
					id: 'ping.get',
					method: 'GET',
					path: '/ping',
					params: t.Object({}),
					query: t.Object({}),
					body: t.Undefined(),
					response: t.Object({ ok: t.Boolean() }),
					docs: { summary: 'ping', tag: 'Test' },
					handler: async () => ({ ok: true }),
				}),
			] as const,
		}),
	});
}

const manifest = defineManifest({
	createEnvironment: (input: EnvironmentInput) => {
		const deps = assembleDeps({ log: consoleLogger, telemetry: input.telemetry });
		return { deps, surfaces: { public: makeSurface(deps) } };
	},
	telemetry: [observabilityModule({ serviceName: 'repro-min' })],
	modules: [pingModule()] as const,
});

new Elysia().use(createApp(manifest)).listen({ port: 3312, hostname: '127.0.0.1' });
console.log('repro-db on :3312');

import { db } from "../src/db";
console.log("db attached", typeof db);
