import { describe, expect, test } from 'bun:test';
import { halt, pipeline, provide } from '../pipeline';
import { defineRouteStage, type RequestContext } from '../route';
import { createTestDeps } from '../testing';

function baseCtx(overrides?: Partial<RequestContext>): RequestContext {
	const { deps } = createTestDeps();
	return {
		requestId: 'req-test',
		surface: 'internal',
		routeId: 'test.route',
		headers: {},
		traceparent: '',
		traceId: '',
		rawParams: undefined,
		rawQuery: undefined,
		rawBody: undefined,
		log: deps.log,
		signal: new AbortController().signal,
		...overrides,
	};
}

interface Actor {
	readonly actor: { readonly type: 'user'; readonly id: string };
}

const authn = defineRouteStage<{ requiresAuth: boolean }, object, Actor>(
	'authn',
	async (decl, ctx) => {
		if (!decl.requiresAuth)
			return provide({ actor: { type: 'user', id: 'anonymous' } });
		const token = ctx.headers['authorization'];
		if (token === undefined) return halt(401, 'UNAUTHENTICATED');
		return provide({ actor: { type: 'user', id: token } });
	}
);

const enrich = defineRouteStage<object, Actor, { greeting: string }>(
	'enrich',
	async (_decl, ctx) => {
		return provide({ greeting: `hello ${ctx.actor.id}` });
	}
);

describe('pipeline', () => {
	test('accumulates context across stages in order', async () => {
		const p = pipeline<RequestContext>().use(authn).use(enrich);
		const run = await p.run(
			{ requiresAuth: true },
			baseCtx({ headers: { authorization: 'dave' } })
		);

		expect(run.kind).toBe('ok');
		if (run.kind !== 'ok') throw new Error('expected ok');
		expect(run.ctx.actor).toEqual({ type: 'user', id: 'dave' });
		expect(run.ctx.greeting).toBe('hello dave');
	});

	test('halt short-circuits later stages and reports the stage name', async () => {
		let enrichRan = false;
		const spy = defineRouteStage<object, Actor, object>(
			'spy',
			async (_decl, _ctx) => {
				enrichRan = true;
				return provide({});
			}
		);
		const p = pipeline<RequestContext>().use(authn).use(spy);
		const run = await p.run({ requiresAuth: true }, baseCtx());

		expect(run.kind).toBe('halt');
		if (run.kind !== 'halt') throw new Error('expected halt');
		expect(run.status).toBe(401);
		expect(run.code).toBe('UNAUTHENTICATED');
		expect(run.stage).toBe('authn');
		expect(enrichRan).toBe(false);
	});

	test('reports per-stage timings to the observer', async () => {
		const timings: string[] = [];
		const p = pipeline<RequestContext>().use(authn).use(enrich);
		await p.run({ requiresAuth: false }, baseCtx(), {
			observe: (stage) => timings.push(stage),
		});

		expect(timings).toEqual(['authn', 'enrich']);
	});

	test('opens one child span per stage, nested under the parent', async () => {
		const { deps, spans } = createTestDeps();
		const root = deps.tracer.startSpan('root');
		const p = pipeline<RequestContext>().use(authn).use(enrich);
		await p.run({ requiresAuth: false }, baseCtx(), {
			tracer: deps.tracer,
			parentSpan: root,
		});

		const stageSpans = spans.filter((s) => s.name.startsWith('stage.'));
		expect(stageSpans.map((s) => s.name)).toEqual([
			'stage.authn',
			'stage.enrich',
		]);
		// Every stage span is a child of the root and shares its trace.
		expect(stageSpans.every((s) => s.parentName === 'root')).toBe(true);
		expect(stageSpans.every((s) => s.traceId === root.traceId)).toBe(true);
		expect(stageSpans.every((s) => s.ended && s.status === 'ok')).toBe(
			true
		);
	});

	test('a halting stage span is marked error with the halt code', async () => {
		const { deps, spans } = createTestDeps();
		const root = deps.tracer.startSpan('root');
		const p = pipeline<RequestContext>().use(authn).use(enrich);
		await p.run({ requiresAuth: true }, baseCtx(), {
			tracer: deps.tracer,
			parentSpan: root,
		});

		const authnSpan = spans.find((s) => s.name === 'stage.authn');
		expect(authnSpan?.status).toBe('error');
		expect(authnSpan?.attributes['halt.code']).toBe('UNAUTHENTICATED');
		// The halted-past stage never opened a span.
		expect(spans.some((s) => s.name === 'stage.enrich')).toBe(false);
	});
});
