import { describe, expect, test } from 'bun:test';
import { Type as t } from '@sinclair/typebox';
import { halt, pipeline, provide } from '../pipeline';
import { defineRouteStage, type RequestContext } from '../route';
import { createTestDeps } from '../testing';
import { createWsHub, createWsTopicFactory, type WsServerFrame } from '../ws';

/**
 * Subscribe pipeline stand-in mirroring the real surface: an authn stage
 * reading the upgrade headers, then a policy stage reading the topic params —
 * the same Decl mechanics routes use.
 */
interface PolicyDecl {
	readonly policy: { readonly orgIdParam: string };
}

function buildPipeline() {
	return pipeline<RequestContext>()
		.use(
			defineRouteStage<object, object, { actor: string }>(
				'authn',
				async (_decl, ctx) => {
					const token = ctx.headers['authorization'];
					if (token === undefined)
						return halt(401, 'UNAUTHENTICATED');
					return provide({ actor: token });
				}
			)
		)
		.use(
			defineRouteStage<PolicyDecl, { actor: string }, object>(
				'policy',
				async (decl, ctx) => {
					const params =
						typeof ctx.rawParams === 'object' &&
						ctx.rawParams !== null
							? Object.fromEntries(
									Object.entries(ctx.rawParams).filter(
										(entry): entry is [string, string] =>
											typeof entry[1] === 'string'
									)
								)
							: {};
					const orgId = params[decl.policy.orgIdParam];
					if (orgId === undefined) {
						return halt(400, 'MISSING_ORG_ID');
					}
					if (!ctx.actor.endsWith(orgId)) {
						return halt(403, 'FORBIDDEN');
					}
					return provide({});
				}
			)
		);
}

function harness() {
	const testDeps = createTestDeps();
	const hub = createWsHub({ deps: testDeps.deps, surface: 'internal' });
	const topicFactory = createWsTopicFactory({
		hub,
		pipeline: buildPipeline(),
	});
	const topic = topicFactory({
		id: 'internal.live.org',
		topic: 'orgs/:orgId/live',
		event: t.Object({ message: t.String({ maxLength: 10 }) }),
		policy: { orgIdParam: 'orgId' },
	});
	return { ...testDeps, hub, topicFactory, topic };
}

function client(hub: ReturnType<typeof harness>['hub'], token?: string) {
	const frames: WsServerFrame[] = [];
	const closes: { code?: number; reason?: string }[] = [];
	const connection = hub.connection(
		{
			send: (text) => {
				frames.push(JSON.parse(text));
			},
			close: (code, reason) => {
				closes.push({ code, reason });
			},
		},
		{ headers: token === undefined ? {} : { authorization: token } }
	);
	return { frames, closes, connection };
}

async function settle(): Promise<void> {
	// Subscribe authorization is async; two macrotask hops settle it.
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('ws topics', () => {
	test('duplicate topic ids fail at registration', () => {
		const { topicFactory } = harness();
		expect(() =>
			topicFactory({
				id: 'internal.live.org',
				topic: 'orgs/:orgId/other',
				event: t.Object({}),
				policy: { orgIdParam: 'orgId' },
			})
		).toThrow('already registered');
	});

	test('subscribe is the policy moment: allowed and denied', async () => {
		const { hub } = harness();
		const allowed = client(hub, 'user-of-org-1');
		const denied = client(hub, 'user-of-org-2');
		const anonymous = client(hub);

		allowed.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'orgs/org-1/live' })
		);
		denied.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'orgs/org-1/live' })
		);
		anonymous.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'orgs/org-1/live' })
		);
		await settle();

		expect(allowed.frames).toEqual([
			{ type: 'subscribed', topic: 'orgs/org-1/live' },
		]);
		expect(denied.frames).toEqual([
			{
				type: 'denied',
				topic: 'orgs/org-1/live',
				status: 403,
				code: 'FORBIDDEN',
			},
		]);
		expect(anonymous.frames).toEqual([
			{
				type: 'denied',
				topic: 'orgs/org-1/live',
				status: 401,
				code: 'UNAUTHENTICATED',
			},
		]);
	});

	test('unknown topic answers 404', async () => {
		const { hub } = harness();
		const socket = client(hub, 'user-of-org-1');
		socket.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'nope/org-1' })
		);
		await settle();
		expect(socket.frames[0]).toEqual({
			type: 'denied',
			topic: 'nope/org-1',
			status: 404,
			code: 'UNKNOWN_TOPIC',
		});
	});

	test('publish fans out only to matching concrete topic; egress filter strips', async () => {
		const { hub, topic } = harness();
		const orgOne = client(hub, 'user-of-org-1');
		const orgTwo = client(hub, 'user-of-org-2');
		orgOne.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'orgs/org-1/live' })
		);
		orgTwo.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'orgs/org-2/live' })
		);
		await settle();

		hub.publish(topic, { orgId: 'org-1' }, { message: 'hello' });

		expect(orgOne.frames).toContainEqual({
			type: 'event',
			topic: 'orgs/org-1/live',
			eventId: 1,
			data: { message: 'hello' },
		});
		expect(
			orgTwo.frames.filter((frame) => frame.type === 'event')
		).toHaveLength(0);
	});

	test('publish rejects schema violations and missing params', () => {
		const { hub, topic } = harness();
		expect(() => hub.publish(topic, {}, { message: 'x' })).toThrow(
			'missing topic param'
		);
		// Type-correct but constraint-violating (maxLength 10) — the runtime
		// egress check must refuse what the compiler cannot.
		expect(() =>
			hub.publish(
				topic,
				{ orgId: 'org-1' },
				{ message: 'this is far too long' }
			)
		).toThrow('violated its event schema');
	});

	test('egress filter strips undeclared fields before fan-out', async () => {
		const { hub, topic } = harness();
		const socket = client(hub, 'user-of-org-1');
		socket.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'orgs/org-1/live' })
		);
		await settle();
		const leaky: { message: string; internal: string } = {
			message: 'hi',
			internal: 'never-send-this',
		};
		hub.publish(topic, { orgId: 'org-1' }, leaky);
		expect(socket.frames).toContainEqual({
			type: 'event',
			topic: 'orgs/org-1/live',
			eventId: 1,
			data: { message: 'hi' },
		});
	});

	test('replay: resubscribe with lastEventId delivers missed events in order', async () => {
		const { hub, topic } = harness();
		const socket = client(hub, 'user-of-org-1');
		socket.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'orgs/org-1/live' })
		);
		await settle();
		hub.publish(topic, { orgId: 'org-1' }, { message: 'one' });
		hub.publish(topic, { orgId: 'org-1' }, { message: 'two' });
		socket.connection.onClose();

		// Missed while disconnected:
		hub.publish(topic, { orgId: 'org-1' }, { message: 'three' });
		hub.publish(topic, { orgId: 'org-1' }, { message: 'four' });

		const reconnected = client(hub, 'user-of-org-1');
		reconnected.connection.onMessage(
			JSON.stringify({
				type: 'subscribe',
				topic: 'orgs/org-1/live',
				lastEventId: 2,
			})
		);
		await settle();
		expect(reconnected.frames).toEqual([
			{ type: 'subscribed', topic: 'orgs/org-1/live' },
			{
				type: 'event',
				topic: 'orgs/org-1/live',
				eventId: 3,
				data: { message: 'three' },
			},
			{
				type: 'event',
				topic: 'orgs/org-1/live',
				eventId: 4,
				data: { message: 'four' },
			},
		]);
	});

	test('unsubscribe and close stop delivery', async () => {
		const { hub, topic } = harness();
		const socket = client(hub, 'user-of-org-1');
		socket.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'orgs/org-1/live' })
		);
		await settle();
		socket.connection.onMessage(
			JSON.stringify({ type: 'unsubscribe', topic: 'orgs/org-1/live' })
		);
		hub.publish(topic, { orgId: 'org-1' }, { message: 'after' });
		expect(
			socket.frames.filter((frame) => frame.type === 'event')
		).toHaveLength(0);
	});

	test('protocol: ping/pong and malformed frames', () => {
		const { hub } = harness();
		const socket = client(hub, 'user-of-org-1');
		socket.connection.onMessage(JSON.stringify({ type: 'ping' }));
		socket.connection.onMessage('not json');
		socket.connection.onMessage(JSON.stringify({ type: 'subscribe' }));
		expect(socket.frames).toEqual([
			{ type: 'pong' },
			{ type: 'error', code: 'MALFORMED_FRAME' },
			{ type: 'error', code: 'MALFORMED_FRAME' },
		]);
	});

	test('pipeline crash: denied 500 + error sink', async () => {
		const testDeps = createTestDeps();
		const hub = createWsHub({ deps: testDeps.deps, surface: 'internal' });
		const topicFactory = createWsTopicFactory({
			hub,
			pipeline: pipeline<RequestContext>().use(
				defineRouteStage('broken', async () => {
					throw new Error('stage bug');
				})
			),
		});
		topicFactory({
			id: 'internal.broken',
			topic: 'broken',
			event: t.Object({}),
		});
		const socket = client(hub, 'anything');
		socket.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'broken' })
		);
		await settle();
		expect(socket.frames[0]).toEqual({
			type: 'denied',
			topic: 'broken',
			status: 500,
			code: 'INTERNAL',
		});
		expect(testDeps.capturedErrors).toHaveLength(1);
		expect(testDeps.capturedErrors[0]?.context.entrypoint).toBe(
			'ws-subscribe'
		);
	});

	test('closeAll: resume hint frame, close 1012, no delivery afterwards', async () => {
		const { hub, topic } = harness();
		const socket = client(hub, 'user-of-org-1');
		socket.connection.onMessage(
			JSON.stringify({ type: 'subscribe', topic: 'orgs/org-1/live' })
		);
		await settle();

		hub.closeAll();

		expect(socket.frames.at(-1)).toEqual({
			type: 'shutdown',
			resume: 'lastEventId',
		});
		expect(socket.closes).toEqual([
			{ code: 1012, reason: 'server restarting' },
		]);

		hub.publish(topic, { orgId: 'org-1' }, { message: 'late' });
		expect(
			socket.frames.filter((frame) => frame.type === 'event')
		).toHaveLength(0);
	});
});
