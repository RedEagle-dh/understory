import { describe, expect, it } from 'bun:test';
import { createTestDeps } from '../../testing';
import {
	createRouteFactory,
	pipeline,
	type RequestContext,
	type RouteInstance,
	t,
} from '../../index';
import {
	assembleDeps,
	createApp,
	defineManifest,
	defineModule,
	type AppEnvironment,
	type EnvironmentInput,
	type ManifestEden,
} from '../index';

const test = createTestDeps();

// A no-stage factory: empty Decl/Provides, so routes declare only their I/O.
const testRoute = createRouteFactory({
	surface: 'test',
	pipeline: pipeline<RequestContext>(),
	deps: test.deps,
});

interface TestEnv extends AppEnvironment {
	readonly surfaces: { readonly test: typeof testRoute };
	readonly greeting: string;
}

const pingModule = defineModule({
	id: 'ping',
	build: (env: TestEnv) => {
		const ping = env.surfaces.test({
			id: 'test.ping',
			method: 'GET',
			path: '/ping',
			params: t.Object({}),
			query: t.Object({}),
			body: t.Undefined(),
			response: t.Object({ message: t.String() }),
			handler: async () => ({ message: env.greeting }),
		});
		return { routes: [ping] as const };
	},
});

const manifest = defineManifest({
	createEnvironment: (_input: EnvironmentInput): TestEnv => ({
		deps: test.deps,
		surfaces: { test: testRoute },
		greeting: 'pong',
	}),
	modules: [pingModule] as const,
});

// Type-level proof: the Eden client type derives from the module tuple with no
// hand-kept route list. Referencing it here means a broken derivation (or a
// collapse to `never`) fails `bun typecheck`.
type AppEden = ManifestEden<typeof manifest.modules>;
const _edenIsElysia: AppEden extends never ? never : true = true;

describe('createApp', () => {
	it('mounts a module route and serves it through Elysia transport', async () => {
		const app = createApp(manifest, { managedLifecycle: false });
		const response = await app.handle(
			new Request('http://localhost/ping')
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ message: 'pong' });
		// The route ran through the framework: an access-log entry was emitted.
		expect(
			test.accessEntries.some((entry) => entry.routeId === 'test.ping')
		).toBe(true);
	});

	it('type-derives Eden without a hand-kept tuple', () => {
		expect(_edenIsElysia).toBe(true);
	});
});

describe('assembleDeps', () => {
	it('falls back to no-op telemetry when no observability module is installed', () => {
		const deps = assembleDeps();
		expect(deps.accessLog).toBeUndefined();
		// The no-op ports are callable and never throw.
		deps.metrics.increment('x');
		deps.metrics.observe('x', 1);
		const span = deps.tracer.startSpan('x');
		span.end();
		expect(() =>
			deps.errorSink.capture(new Error('boom'), {
				entrypoint: 'route',
				requestId: 'r1',
			})
		).not.toThrow();
	});

	it('uses telemetry ports when supplied', () => {
		const deps = assembleDeps({ telemetry: test.deps });
		// test.deps' tracer records spans; assembleDeps must pass it through.
		const before = test.spans.length;
		deps.tracer.startSpan('probe').end();
		expect(test.spans.length).toBe(before + 1);
	});
});
