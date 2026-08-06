import { describe, expect, test } from 'bun:test';
import { Type as t } from '@sinclair/typebox';
import { halt, pipeline, provide } from '../pipeline';
import type {
	HttpIdempotencyStorePort,
	IdempotencyBegin,
	IdempotencyScope,
	StoredIdempotentResponse,
} from '../ports';
import {
	createRouteFactory,
	defineRouteStage,
	type RequestContext,
} from '../route';
import { createTestDeps } from '../testing';

interface Actor {
	readonly actor: { readonly id: string };
}

const authn = defineRouteStage<object, object, Actor>(
	'authn',
	async (_decl, ctx) => {
		const user = ctx.headers['x-user'];
		if (user === undefined) return halt(401, 'UNAUTHENTICATED');
		return provide({ actor: { id: user } });
	}
);

interface StoreCalls {
	readonly begins: IdempotencyScope[];
	readonly completes: Array<{
		scope: IdempotencyScope;
		response: StoredIdempotentResponse;
	}>;
	readonly abandons: IdempotencyScope[];
}

function fakeStore(next: () => IdempotencyBegin): {
	store: HttpIdempotencyStorePort;
	calls: StoreCalls;
} {
	const calls: StoreCalls = { begins: [], completes: [], abandons: [] };
	return {
		calls,
		store: {
			begin: async (scope) => {
				calls.begins.push(scope);
				return next();
			},
			complete: async (scope, response) => {
				calls.completes.push({ scope, response });
			},
			abandon: async (scope) => {
				calls.abandons.push(scope);
			},
		},
	};
}

function setup(next: () => IdempotencyBegin) {
	const { store, calls } = fakeStore(next);
	const testDeps = createTestDeps();
	const route = createRouteFactory({
		surface: 'internal',
		pipeline: pipeline<RequestContext>().use(authn),
		deps: testDeps.deps,
		idempotencyStore: store,
		attribution: (ctx) => ({
			actorId: ctx.actor?.id,
			tenantId: 'org-home',
		}),
	});
	let handlerRuns = 0;
	const create = route({
		id: 'things.create',
		method: 'POST',
		path: '/things',
		idempotency: true,
		params: t.Object({}),
		query: t.Object({}),
		body: t.Object({ name: t.String() }),
		response: t.Object({ id: t.String() }),
		successStatus: 201,
		handler: async (ctx) => {
			handlerRuns += 1;
			if (ctx.body.name === 'boom') throw new Error('kaboom');
			return { id: 'thing-1' };
		},
	});
	return { create, calls, handlerRuns: () => handlerRuns, ...testDeps };
}

const input = {
	params: {},
	query: {},
	body: { name: 'a' },
	headers: { 'x-user': 'usr-dave', 'idempotency-key': 'key-1' },
};

describe('route idempotency', () => {
	test('a fresh key executes the handler and persists the response', async () => {
		const { create, calls, handlerRuns } = setup(() => ({ kind: 'fresh' }));
		const result = await create.execute(input);

		expect(result.status).toBe(201);
		expect(handlerRuns()).toBe(1);
		expect(calls.begins[0]).toMatchObject({
			surface: 'internal',
			routeId: 'things.create',
			actorId: 'usr-dave',
			tenantId: 'org-home',
			key: 'key-1',
		});
		expect(calls.completes[0]?.response).toEqual({
			status: 201,
			body: { id: 'thing-1' },
		});
		expect(calls.abandons).toHaveLength(0);
	});

	test('a stored response replays without running the handler', async () => {
		const { create, handlerRuns } = setup(() => ({
			kind: 'replay',
			response: { status: 201, body: { id: 'thing-original' } },
		}));
		const result = await create.execute(input);

		expect(result.status).toBe(201);
		expect(result.body).toEqual({ id: 'thing-original' });
		expect(result.headers['idempotency-replayed']).toBe('true');
		expect(handlerRuns()).toBe(0);
	});

	test('a concurrent duplicate answers 409 without running the handler', async () => {
		const { create, handlerRuns } = setup(() => ({ kind: 'in-progress' }));
		const result = await create.execute(input);

		expect(result.status).toBe(409);
		expect(result.body).toMatchObject({
			error: 'IDEMPOTENCY_IN_PROGRESS',
		});
		expect(handlerRuns()).toBe(0);
	});

	test('a failing handler releases the key instead of storing the failure', async () => {
		const { create, calls } = setup(() => ({ kind: 'fresh' }));
		const result = await create.execute({
			...input,
			body: { name: 'boom' },
		});

		expect(result.status).toBe(500);
		expect(calls.completes).toHaveLength(0);
		expect(calls.abandons).toHaveLength(1);
	});

	test('a missing Idempotency-Key header is a 400 and never claims the store', async () => {
		const { create, calls } = setup(() => ({ kind: 'fresh' }));
		const result = await create.execute({
			...input,
			headers: { 'x-user': 'usr-dave' },
		});

		expect(result.status).toBe(400);
		expect(result.body).toMatchObject({
			error: 'IDEMPOTENCY_KEY_REQUIRED',
		});
		expect(calls.begins).toHaveLength(0);
	});

	test('validation failures never claim the key', async () => {
		const { create, calls } = setup(() => ({ kind: 'fresh' }));
		const result = await create.execute({ ...input, body: {} });

		expect(result.status).toBe(422);
		expect(calls.begins).toHaveLength(0);
	});

	test('declaring idempotency without a store on the factory fails at definition', () => {
		const testDeps = createTestDeps();
		const route = createRouteFactory({
			surface: 'internal',
			pipeline: pipeline<RequestContext>().use(authn),
			deps: testDeps.deps,
		});
		expect(() =>
			route({
				id: 'things.create',
				method: 'POST',
				path: '/things',
				idempotency: true,
				params: t.Object({}),
				query: t.Object({}),
				body: t.Object({}),
				response: t.Object({}),
				handler: async () => ({}),
			})
		).toThrow(/HttpIdempotencyStorePort/);
	});
});
