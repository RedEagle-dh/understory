import { describe, expect, test } from 'bun:test';
import { Type as t } from '@sinclair/typebox';
import { createFlagStage, type FlagsPort } from '../flags';
import { pipeline } from '../pipeline';
import { createRouteFactory, type RequestContext } from '../route';
import { createTestDeps } from '../testing';

function setup(enabledFlags: readonly string[]) {
	const asked: Array<{ key: string; userId?: string }> = [];
	const flags: FlagsPort = {
		isEnabled: async (key, subject) => {
			asked.push({ key, userId: subject.userId });
			return enabledFlags.includes(key);
		},
	};
	const testDeps = createTestDeps();
	const route = createRouteFactory({
		surface: 'internal',
		pipeline: pipeline<RequestContext>().use(
			createFlagStage<object>(flags, (ctx) => ({
				userId: ctx.headers['x-user'],
			}))
		),
		deps: testDeps.deps,
	});
	return { route, asked };
}

function flaggedRoute(route: ReturnType<typeof setup>['route'], flag?: string) {
	return route({
		id: 'things.flagged',
		method: 'GET',
		path: '/flagged',
		flag,
		params: t.Object({}),
		query: t.Object({}),
		body: t.Undefined(),
		response: t.Object({ ok: t.Boolean() }),
		handler: async () => ({ ok: true }),
	});
}

describe('flag stage', () => {
	test('an enabled flag lets the request through', async () => {
		const { route } = setup(['new_thing']);
		const result = await flaggedRoute(route, 'new_thing').execute({
			params: {},
			query: {},
			headers: { 'x-user': 'usr-dave' },
		});

		expect(result.status).toBe(200);
	});

	test('a disabled flag hides the route: 404, subject taken from the extractor', async () => {
		const { route, asked } = setup([]);
		const result = await flaggedRoute(route, 'new_thing').execute({
			params: {},
			query: {},
			headers: { 'x-user': 'usr-dave' },
		});

		expect(result.status).toBe(404);
		expect(result.body).toMatchObject({ error: 'NOT_FOUND' });
		expect(asked).toEqual([{ key: 'new_thing', userId: 'usr-dave' }]);
	});

	test('routes without a flag declaration never hit the port', async () => {
		const { route, asked } = setup([]);
		const result = await flaggedRoute(route).execute({
			params: {},
			query: {},
		});

		expect(result.status).toBe(200);
		expect(asked).toHaveLength(0);
	});
});
