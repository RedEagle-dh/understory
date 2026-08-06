import { describe, expect, test } from 'bun:test';
import {
	createRouteFactory,
	pipeline,
	type RequestContext,
	t,
} from '@declarativejs/core';
import { createTestDeps } from '@declarativejs/core/testing';
import type { Auth } from '../auth/auth';
import { createAuthStage } from '../auth/stage';

type SessionResult = Awaited<ReturnType<Auth['api']['getSession']>>;

function makeAuthStub(session: SessionResult): Auth {
	return {
		api: { getSession: async () => session },
	} as unknown as Auth;
}

function makeFactory(session: SessionResult) {
	const { deps } = createTestDeps();
	return createRouteFactory({
		surface: 'authed',
		pipeline: pipeline<RequestContext>().use(
			createAuthStage(makeAuthStub(session))
		),
		deps,
	});
}

const routeShape = {
	method: 'GET',
	path: '/api/whoami',
	params: t.Object({}),
	query: t.Object({}),
	body: t.Undefined(),
	response: t.Object({ userId: t.String(), role: t.String() }),
	docs: { summary: 'test', tag: 'Test' },
} as const;

function sessionFor(role: string, banned = false): SessionResult {
	return {
		user: {
			id: 'u1',
			email: 'u@example.com',
			name: 'U',
			role,
			banned,
		},
		session: { id: 's1' },
	} as unknown as SessionResult;
}

async function run(
	factory: ReturnType<typeof makeFactory>,
	policy: 'authenticated' | { permissions: { project?: readonly ['scan'] } }
) {
	const route = factory({
		...routeShape,
		id: 'test.whoami',
		policy,
		handler: async (ctx) => ({ userId: ctx.user.id, role: ctx.role }),
	});
	return route.execute({
		params: {},
		query: {},
		headers: { cookie: 'session=x' },
	});
}

describe('auth stage', () => {
	test('no session → 401', async () => {
		const result = await run(makeFactory(null), 'authenticated');
		expect(result.status).toBe(401);
	});

	test('banned user → 403', async () => {
		const result = await run(
			makeFactory(sessionFor('viewer', true)),
			'authenticated'
		);
		expect(result.status).toBe(403);
	});

	test('unknown role → 403', async () => {
		const result = await run(
			makeFactory(sessionFor('root')),
			'authenticated'
		);
		expect(result.status).toBe(403);
	});

	test('viewer denied project:scan', async () => {
		const result = await run(makeFactory(sessionFor('viewer')), {
			permissions: { project: ['scan'] },
		});
		expect(result.status).toBe(403);
	});

	test('maintainer allowed project:scan, handler sees user', async () => {
		const result = await run(makeFactory(sessionFor('maintainer')), {
			permissions: { project: ['scan'] },
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ userId: 'u1', role: 'maintainer' });
	});

	test('compile-time: omitting policy on the authed surface is an error', () => {
		const factory = makeFactory(sessionFor('admin'));
		const missingPolicy = () =>
			// @ts-expect-error — policy is required once the auth stage is installed
			factory({
				...routeShape,
				id: 'test.nopolicy',
				handler: async (ctx) => ({
					userId: ctx.user.id,
					role: ctx.role,
				}),
			});
		expect(missingPolicy).toBeInstanceOf(Function);
	});
});
