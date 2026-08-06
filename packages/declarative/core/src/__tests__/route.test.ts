import { describe, expect, test } from 'bun:test';
import { Type as t } from '@sinclair/typebox';
import { TypedError } from '../errors';
import { halt, pipeline, provide } from '../pipeline';
import {
	createRouteFactory,
	defineRouteStage,
	type RequestContext,
} from '../route';
import { createTestDeps } from '../testing';

interface Actor {
	readonly actor: { readonly id: string };
}

const authn = defineRouteStage<{ requiresAuth: boolean }, object, Actor>(
	'authn',
	async (decl, ctx) => {
		if (!decl.requiresAuth) return provide({ actor: { id: 'anonymous' } });
		const token = ctx.headers['authorization'];
		if (token === undefined) return halt(401, 'UNAUTHENTICATED');
		return provide({ actor: { id: token } });
	}
);

class ChannelNotFoundError extends TypedError {
	readonly code = 'CHANNEL_NOT_FOUND';
	readonly status = 404;

	constructor(channelId: string) {
		super(`Channel ${channelId} not found`);
	}
}

function setup() {
	const testDeps = createTestDeps();
	const route = createRouteFactory({
		surface: 'internal',
		pipeline: pipeline<RequestContext>().use(authn),
		deps: testDeps.deps,
		defaultTimeoutMs: 200,
		attribution: (ctx) => ({ actorId: ctx.actor?.id }),
	});
	return { route, ...testDeps };
}

const listThings = (route: ReturnType<typeof setup>['route']) =>
	route({
		id: 'things.list',
		method: 'GET',
		path: '/things/:channelId',
		requiresAuth: true,
		params: t.Object({ channelId: t.String() }),
		query: t.Object({ limit: t.Number({ default: 10 }) }),
		body: t.Undefined(),
		response: t.Object({
			channelId: t.String(),
			limit: t.Number(),
			actorId: t.String(),
		}),
		errors: [ChannelNotFoundError],
		handler: async (ctx) => {
			if (ctx.params.channelId === 'missing')
				throw new ChannelNotFoundError(ctx.params.channelId);
			if (ctx.params.channelId === 'boom') throw new Error('kaboom');
			return {
				channelId: ctx.params.channelId,
				limit: ctx.query.limit,
				actorId: ctx.actor.id,
			};
		},
	});

describe('route factory', () => {
	test('runs pipeline, parses inputs (with coercion/defaults) and calls the typed handler', async () => {
		const { route } = setup();
		const result = await listThings(route).execute({
			params: { channelId: 'c1' },
			query: { limit: '25' },
			headers: { authorization: 'dave' },
		});

		expect(result.status).toBe(200);
		expect(result.body).toEqual({
			channelId: 'c1',
			limit: 25,
			actorId: 'dave',
		});
	});

	test('halt from a stage becomes the response and the handler never runs', async () => {
		const { route } = setup();
		const result = await listThings(route).execute({
			params: { channelId: 'c1' },
			query: {},
		});

		expect(result.status).toBe(401);
		expect(result.body).toMatchObject({ error: 'UNAUTHENTICATED' });
	});

	test('invalid input yields 422 VALIDATION_FAILED', async () => {
		const { route } = setup();
		const result = await listThings(route).execute({
			params: { channelId: 'c1' },
			query: { limit: 'not-a-number' },
			headers: { authorization: 'dave' },
		});

		expect(result.status).toBe(422);
		expect(result.body).toMatchObject({ error: 'VALIDATION_FAILED' });
	});

	test('declared TypedError maps to its status and code without hitting the error sink', async () => {
		const { route, capturedErrors } = setup();
		const result = await listThings(route).execute({
			params: { channelId: 'missing' },
			query: {},
			headers: { authorization: 'dave' },
		});

		expect(result.status).toBe(404);
		expect(result.body).toMatchObject({ error: 'CHANNEL_NOT_FOUND' });
		expect(capturedErrors).toHaveLength(0);
	});

	test('undeclared error is a bug: 500, no leaked message, captured by the error sink', async () => {
		const { route, capturedErrors } = setup();
		const result = await listThings(route).execute({
			params: { channelId: 'boom' },
			query: {},
			headers: { authorization: 'dave' },
		});

		expect(result.status).toBe(500);
		expect(result.body).toMatchObject({ error: 'INTERNAL' });
		expect(JSON.stringify(result.body)).not.toContain('kaboom');
		expect(capturedErrors).toHaveLength(1);
		expect(capturedErrors[0]?.context.entrypoint).toBe('route');
	});

	test('an undeclared error is captured with enriched attribution (traceId, actor, route)', async () => {
		const { route, capturedErrors, spans } = setup();
		await listThings(route).execute({
			params: { channelId: 'boom' },
			query: {},
			headers: { authorization: 'dave' },
		});

		const ctx = capturedErrors[0]?.context;
		const root = spans.find((s) => s.name === 'GET things.list');
		expect(ctx?.route).toBe('things.list');
		expect(ctx?.actorId).toBe('dave');
		expect(ctx?.traceId).toBe(root?.traceId);
	});

	test('handler exceeding the timeout yields 504 TIMEOUT', async () => {
		const { route } = setup();
		const slow = route({
			id: 'things.slow',
			method: 'GET',
			path: '/slow',
			requiresAuth: false,
			timeoutMs: 20,
			params: t.Object({}),
			query: t.Object({}),
			body: t.Undefined(),
			response: t.Object({}),
			handler: async () => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return {};
			},
		});
		const result = await slow.execute({ params: {}, query: {} });

		expect(result.status).toBe(504);
		expect(result.body).toMatchObject({ error: 'TIMEOUT' });
	});

	test('opens a root span, continues an inbound trace, and ends it ok', async () => {
		const { route, spans } = setup();
		await listThings(route).execute({
			params: { channelId: 'c1' },
			query: {},
			headers: {
				authorization: 'dave',
				traceparent:
					'00-1234567890abcdef1234567890abcdef-abcdef1234567890-01',
			},
		});

		const root = spans.find((s) => s.name === 'GET things.list');
		expect(root?.remoteParent).toBe(
			'00-1234567890abcdef1234567890abcdef-abcdef1234567890-01'
		);
		expect(root?.traceId).toBe('1234567890abcdef1234567890abcdef');
		expect(root?.attributes['http.status_code']).toBe(200);
		expect(root?.status).toBe('ok');
		expect(root?.ended).toBe(true);
	});

	test('an undeclared error is recorded on the root span, ends it as error, and correlates logs by traceId', async () => {
		const { route, spans, logs } = setup();
		await listThings(route).execute({
			params: { channelId: 'boom' },
			query: {},
			headers: { authorization: 'dave' },
		});

		const root = spans.find((s) => s.name === 'GET things.list');
		expect(root?.errors).toHaveLength(1);
		expect(root?.attributes['http.status_code']).toBe(500);
		expect(root?.status).toBe('error');
		expect(root?.ended).toBe(true);
		// The 'unhandled error' log line carries the trace id for correlation.
		expect(logs.some((l) => l.bindings['traceId'] === root?.traceId)).toBe(
			true
		);
	});

	test('every response echoes x-request-id — success, halt and 500 alike', async () => {
		const { route } = setup();
		const instance = listThings(route);

		const success = await instance.execute({
			params: { channelId: 'c1' },
			query: {},
			headers: { authorization: 'dave' },
		});
		const halted = await instance.execute({
			params: { channelId: 'c1' },
			query: {},
		});
		const failed = await instance.execute({
			params: { channelId: 'boom' },
			query: {},
			headers: { authorization: 'dave' },
		});

		expect(success.headers['x-request-id']).toMatch(/^req-/);
		expect(halted.headers['x-request-id']).toMatch(/^req-/);
		expect(failed.headers['x-request-id']).toMatch(/^req-/);
	});

	test('egress filter strips fields the response schema does not declare', async () => {
		const { route } = setup();
		const leaky = route({
			id: 'things.leaky',
			method: 'GET',
			path: '/leaky',
			requiresAuth: false,
			params: t.Object({}),
			query: t.Object({}),
			body: t.Undefined(),
			response: t.Object({ name: t.String() }),
			handler: async () => {
				const row = { name: 'public', passwordHash: 'secret' };
				return row;
			},
		});
		const result = await leaky.execute({ params: {}, query: {} });

		expect(result.status).toBe(200);
		expect(result.body).toEqual({ name: 'public' });
	});

	test('a response violating its schema after cleaning is a bug: 500 + error sink', async () => {
		const { route, capturedErrors } = setup();
		const broken = route({
			id: 'things.broken-egress',
			method: 'GET',
			path: '/broken-egress',
			requiresAuth: false,
			params: t.Object({}),
			query: t.Object({}),
			body: t.Undefined(),
			// The constraint is invisible to the type system, so the handler
			// compiles yet violates the schema at runtime.
			response: t.Object({ code: t.String({ maxLength: 3 }) }),
			handler: async () => ({ code: 'way-too-long' }),
		});
		const result = await broken.execute({ params: {}, query: {} });

		expect(result.status).toBe(500);
		expect(result.body).toMatchObject({ error: 'INTERNAL' });
		expect(capturedErrors).toHaveLength(1);
		expect(String(capturedErrors[0]?.error)).toContain(
			'violated its response schema'
		);
	});

	test('defining a route with an unbounded ingress array fails at composition', () => {
		const { route } = setup();
		expect(() =>
			route({
				id: 'things.unbounded',
				method: 'POST',
				path: '/unbounded',
				requiresAuth: false,
				params: t.Object({}),
				query: t.Object({}),
				body: t.Object({ ids: t.Array(t.String()) }),
				response: t.Object({}),
				handler: async () => ({}),
			})
		).toThrow(/unbounded|maxItems/);

		// Bounded ingress and (server-produced) response arrays are fine.
		expect(() =>
			route({
				id: 'things.bounded',
				method: 'POST',
				path: '/bounded',
				requiresAuth: false,
				params: t.Object({}),
				query: t.Object({}),
				body: t.Object({ ids: t.Array(t.String(), { maxItems: 50 }) }),
				response: t.Object({ items: t.Array(t.String()) }),
				handler: async () => ({ items: [] }),
			})
		).not.toThrow();
	});

	test('stages see the transport-resolved client ip', async () => {
		const seen: Array<string | undefined> = [];
		const ipSpy = defineRouteStage<object, object, object>(
			'ip-spy',
			async (_decl, ctx) => {
				seen.push(ctx.ip);
				return provide({});
			}
		);
		const { deps } = createTestDeps();
		const route = createRouteFactory({
			surface: 'internal',
			pipeline: pipeline<RequestContext>().use(ipSpy),
			deps,
		});
		const instance = route({
			id: 'things.ip',
			method: 'GET',
			path: '/ip',
			params: t.Object({}),
			query: t.Object({}),
			body: t.Undefined(),
			response: t.Object({}),
			handler: async () => ({}),
		});
		await instance.execute({ params: {}, query: {}, ip: '203.0.113.7' });

		expect(seen).toEqual(['203.0.113.7']);
	});

	test('exposes the declared schemas for OpenAPI generation and audits', () => {
		const { route } = setup();
		const instance = listThings(route);

		expect(instance.schemas.params).toMatchObject({ type: 'object' });
		expect(instance.schemas.response).toMatchObject({ type: 'object' });
	});

	test('emits one attributed access-log entry per request — success, halt and 500', async () => {
		const { route, accessEntries } = setup();
		const instance = listThings(route);

		await instance.execute({
			params: { channelId: 'c1' },
			query: {},
			headers: { authorization: 'dave', 'user-agent': 'test-agent' },
			ip: '203.0.113.7',
		});
		await instance.execute({ params: { channelId: 'c1' }, query: {} });
		await instance.execute({
			params: { channelId: 'boom' },
			query: {},
			headers: { authorization: 'dave' },
		});

		expect(accessEntries).toHaveLength(3);
		expect(accessEntries[0]).toMatchObject({
			routeId: 'things.list',
			surface: 'internal',
			method: 'GET',
			status: 200,
			actorId: 'dave',
			ip: '203.0.113.7',
			userAgent: 'test-agent',
			occurredAt: '2026-01-01T00:00:00.000Z',
		});
		expect(accessEntries[0]?.requestId).toMatch(/^req-/);
		// Halted before authn resolved an actor: attributed as anonymous.
		expect(accessEntries[1]).toMatchObject({ status: 401 });
		expect(accessEntries[1]?.actorId).toBeUndefined();
		// Handler bug: the 500 still carries its actor.
		expect(accessEntries[2]).toMatchObject({
			status: 500,
			actorId: 'dave',
		});
	});

	test('a declared audit action stamps the access-log entry (sensitive reads, ADR-0010)', async () => {
		const { route, accessEntries } = setup();
		const exportRoute = route({
			id: 'things.export',
			method: 'GET',
			path: '/export',
			requiresAuth: true,
			audit: { action: 'data.exported' },
			params: t.Object({}),
			query: t.Object({}),
			body: t.Undefined(),
			response: t.Object({}),
			handler: async () => ({}),
		});
		await exportRoute.execute({
			params: {},
			query: {},
			headers: { authorization: 'dave' },
		});

		expect(accessEntries[0]?.audit).toBe('data.exported');
		// Routes without the declaration carry no audit marker.
		await listThings(route).execute({
			params: { channelId: 'c1' },
			query: {},
			headers: { authorization: 'dave' },
		});
		expect(accessEntries[1]?.audit).toBeUndefined();
	});

	test('records RED metrics including per-stage timings', async () => {
		const { route, counters, observations } = setup();
		await listThings(route).execute({
			params: { channelId: 'c1' },
			query: {},
			headers: { authorization: 'dave' },
		});

		const counted = counters.find((c) => c.name === 'http_requests_total');
		expect(counted?.labels).toMatchObject({
			route: 'things.list',
			surface: 'internal',
			status: '2xx',
		});
		expect(
			observations.some(
				(o) =>
					o.name === 'http_stage_duration_ms' &&
					o.labels?.stage === 'authn'
			)
		).toBe(true);
		expect(
			observations.some((o) => o.name === 'http_request_duration_ms')
		).toBe(true);
	});
});
