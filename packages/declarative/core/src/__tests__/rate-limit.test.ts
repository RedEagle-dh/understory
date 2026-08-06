import { describe, expect, test } from 'bun:test';
import { Type as t } from '@sinclair/typebox';
import { pipeline } from '../pipeline';
import type { RateLimiterPort } from '../ports';
import { createRateLimitStage, type RateLimitPreset } from '../rate-limit';
import { createRouteFactory, type RequestContext } from '../route';
import { createTestDeps } from '../testing';

interface Consumed {
	readonly bucket: string;
	readonly key: string;
	readonly limit: number;
}

function setup(allowed: boolean, retryAfterSeconds?: number) {
	const consumed: Consumed[] = [];
	const limiter: RateLimiterPort = {
		consume: async (bucket, key, limit) => {
			consumed.push({ bucket, key, limit });
			return { allowed, retryAfterSeconds };
		},
	};
	const presets = {
		read: { limit: 100, windowSeconds: 60, scope: 'actor' },
		burst: { limit: 10, windowSeconds: 60, scope: 'ip' },
	} as const satisfies Record<string, RateLimitPreset>;
	const testDeps = createTestDeps();
	const route = createRouteFactory({
		surface: 'internal',
		pipeline: pipeline<RequestContext>().use(
			createRateLimitStage<object, typeof presets>(
				limiter,
				presets,
				(ctx) => ({ actorId: ctx.headers['x-user'] })
			)
		),
		deps: testDeps.deps,
	});
	return { route, consumed };
}

function limitedRoute(
	route: ReturnType<typeof setup>['route'],
	rateLimit?: 'read' | 'burst'
) {
	return route({
		id: 'things.limited',
		method: 'GET',
		path: '/limited',
		rateLimit,
		params: t.Object({}),
		query: t.Object({}),
		body: t.Undefined(),
		response: t.Object({ ok: t.Boolean() }),
		handler: async () => ({ ok: true }),
	});
}

describe('rate limit stage', () => {
	test('consumes the preset against the scoped key and lets allowed requests through', async () => {
		const { route, consumed } = setup(true);
		const result = await limitedRoute(route, 'read').execute({
			params: {},
			query: {},
			headers: { 'x-user': 'usr-dave' },
		});

		expect(result.status).toBe(200);
		expect(consumed).toEqual([
			{
				bucket: 'internal:things.limited:read',
				key: 'usr-dave',
				limit: 100,
			},
		]);
	});

	test('a denied request answers 429 with Retry-After', async () => {
		const { route } = setup(false, 42);
		const result = await limitedRoute(route, 'read').execute({
			params: {},
			query: {},
			headers: { 'x-user': 'usr-dave' },
		});

		expect(result.status).toBe(429);
		expect(result.body).toMatchObject({ error: 'RATE_LIMITED' });
		expect(result.headers['retry-after']).toBe('42');
		expect(result.headers['x-request-id']).toMatch(/^req-/);
	});

	test('ip-scoped presets key on the transport-resolved ip', async () => {
		const { route, consumed } = setup(true);
		await limitedRoute(route, 'burst').execute({
			params: {},
			query: {},
			ip: '203.0.113.7',
		});

		expect(consumed[0]?.key).toBe('203.0.113.7');
	});

	test('routes without a preset and unresolvable keys never deny', async () => {
		const { route, consumed } = setup(false);

		const unlimited = await limitedRoute(route).execute({
			params: {},
			query: {},
		});
		// actor scope, but no actor resolvable: fail open.
		const keyless = await limitedRoute(route, 'read').execute({
			params: {},
			query: {},
		});

		expect(unlimited.status).toBe(200);
		expect(keyless.status).toBe(200);
		expect(consumed).toHaveLength(0);
	});
});
