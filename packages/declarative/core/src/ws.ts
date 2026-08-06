import { type StaticEncode, type TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import type { Pipeline } from './pipeline';
import type { FactoryDeps } from './ports';
import type { RequestContext } from './route';

/**
 * `ws()` — declarative WebSocket topics (ADR-0005). The design decisions the
 * ADR fixes, implemented here:
 *
 * - **Subscribe (not connect) is the policy moment.** A connection is cheap
 *   and anonymous; each `subscribe` frame runs a full request pipeline
 *   (authn → policy → ... — the SAME stage instances routes use, over a
 *   RequestContext built from the upgrade headers and the topic params).
 * - **Lossless reconnect via last-event-id.** Every published event gets a
 *   per-topic monotonic id; a resubscribe with `lastEventId` replays what was
 *   missed from a bounded in-memory buffer. The JetStream-backed replay (and
 *   revocation via permission-change events) arrives with the shared ws
 *   package ADR-0013 needs; ids reset on restart, so clients must treat an
 *   empty replay as a full-refresh signal.
 * - Topics are publish-only server→client. Client→server work is `route()`.
 */

/** Client → server frames. Anything else answers `{type:'error'}`. */
export type WsClientFrame =
	| {
			readonly type: 'subscribe';
			readonly topic: string;
			readonly lastEventId?: number;
	  }
	| { readonly type: 'unsubscribe'; readonly topic: string }
	| { readonly type: 'ping' };

export type WsServerFrame =
	| { readonly type: 'subscribed'; readonly topic: string }
	| {
			readonly type: 'denied';
			readonly topic: string;
			readonly status: number;
			readonly code: string;
	  }
	| { readonly type: 'unsubscribed'; readonly topic: string }
	| {
			readonly type: 'event';
			readonly topic: string;
			readonly eventId: number;
			readonly data: unknown;
	  }
	| { readonly type: 'pong' }
	| { readonly type: 'error'; readonly code: string }
	| {
			/**
			 * Sent to every client right before a graceful shutdown closes the
			 * socket (then close code 1012, Service Restart). The resume hint:
			 * reconnect with backoff and resubscribe with your `lastEventId` —
			 * an empty replay means the buffer was lost, do a full refresh
			 * (ids reset on restart, see module doc).
			 */
			readonly type: 'shutdown';
			readonly resume: 'lastEventId';
	  };

export interface WsTopicShape<
	// Unused in the body by design (see RouteShape): instantiated by the
	// factory as `WsTopicShape<Decl, Event> & Decl`.
	_Decl extends object,
	Event extends TSchema,
> {
	readonly id: string;
	/**
	 * Topic pattern with `:param` segments (e.g. `orgs/:orgId/live`). Params
	 * feed the subscribe pipeline as rawParams — the policy stage reads its
	 * `orgIdParam`/`channelIdParam` from them exactly like route paths.
	 */
	readonly topic: string;
	/** Server→client event payload schema — the egress filter per publish. */
	readonly event: Event;
}

export interface WsTopicInstance<Event extends TSchema> {
	readonly id: string;
	readonly topic: string;
	readonly event: Event;
}

interface RegisteredTopic {
	readonly id: string;
	readonly segments: readonly string[];
	readonly cleanEvent: (data: unknown) => unknown;
	readonly checkEvent: (data: unknown) => string | null;
	readonly authorize: (ctx: RequestContext) => Promise<
		| { readonly ok: true }
		| {
				readonly ok: false;
				readonly status: number;
				readonly code: string;
		  }
	>;
}

interface Subscriber {
	readonly connectionId: string;
	readonly send: (frame: WsServerFrame) => boolean;
}

interface TopicChannel {
	nextEventId: number;
	readonly entries: { readonly eventId: number; readonly data: unknown }[];
	readonly subscribers: Map<string, Subscriber>;
}

export interface WsConnectionInfo {
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly ip?: string;
}

export interface WsConnectionTransport {
	send(text: string): void;
	close(code?: number, reason?: string): void;
}

export interface WsConnection {
	readonly id: string;
	/** Feed one inbound message (raw text or pre-parsed JSON). */
	readonly onMessage: (raw: unknown) => void;
	readonly onClose: () => void;
}

export interface WsHubConfig {
	readonly deps: FactoryDeps;
	/** Surface label for metrics and the subscribe pipeline ctx. */
	readonly surface: string;
	/** Replay buffer capacity per concrete topic. Default 256 events. */
	readonly replayBufferSize?: number;
	/** Frame budget for one subscribe authorization. Default 10s. */
	readonly subscribeTimeoutMs?: number;
}

const SUBSCRIBE_TIMEOUT_MS = 10_000;
const REPLAY_BUFFER_SIZE = 256;

function splitTopic(pattern: string): readonly string[] {
	const segments = pattern.split('/');
	if (segments.some((segment) => segment === '')) {
		throw new Error(`ws topic: empty segment in "${pattern}"`);
	}
	return segments;
}

function matchTopic(
	segments: readonly string[],
	concrete: readonly string[]
): Record<string, string> | null {
	if (segments.length !== concrete.length) return null;
	const params: Record<string, string> = {};
	for (let index = 0; index < segments.length; index += 1) {
		const pattern = segments[index];
		const value = concrete[index];
		if (pattern === undefined || value === undefined) return null;
		if (pattern.startsWith(':')) {
			params[pattern.slice(1)] = value;
		} else if (pattern !== value) {
			return null;
		}
	}
	return params;
}

function fillTopic(
	segments: readonly string[],
	params: Readonly<Record<string, string>>
): string {
	return segments
		.map((segment) => {
			if (!segment.startsWith(':')) return segment;
			const value = params[segment.slice(1)];
			if (value === undefined || value === '') {
				throw new Error(
					`ws publish: missing topic param "${segment.slice(1)}"`
				);
			}
			return value;
		})
		.join('/');
}

function parseClientFrame(raw: unknown): WsClientFrame | null {
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (typeof value !== 'object' || value === null) return null;
	const frame: Record<string, unknown> = { ...value };
	if (frame['type'] === 'ping') return { type: 'ping' };
	if (frame['type'] === 'subscribe' || frame['type'] === 'unsubscribe') {
		if (typeof frame['topic'] !== 'string' || frame['topic'] === '') {
			return null;
		}
		if (frame['type'] === 'unsubscribe') {
			return { type: 'unsubscribe', topic: frame['topic'] };
		}
		const lastEventId = frame['lastEventId'];
		if (lastEventId !== undefined && typeof lastEventId !== 'number') {
			return null;
		}
		return {
			type: 'subscribe',
			topic: frame['topic'],
			...(typeof lastEventId === 'number' ? { lastEventId } : {}),
		};
	}
	return null;
}

/**
 * The transport-agnostic hub: topic registry, subscribe authorization,
 * fan-out and the replay buffer. `mountWsHub` (ws-elysia.ts) binds it to the
 * server; `createWsTopicFactory` binds topic declarations to a pipeline.
 * One hub per app — topics from factories with DIFFERENT pipelines (e.g.
 * authn-only vs. full tenant policy) coexist on the same endpoint.
 */
export class WsHub {
	private readonly topics: RegisteredTopic[] = [];
	private readonly channels = new Map<string, TopicChannel>();
	private readonly connections = new Map<string, WsConnectionTransport>();
	private readonly deps: FactoryDeps;
	private readonly surface: string;
	private readonly replaySize: number;
	private readonly subscribeTimeoutMs: number;

	constructor(config: WsHubConfig) {
		this.deps = config.deps;
		this.surface = config.surface;
		this.replaySize = config.replayBufferSize ?? REPLAY_BUFFER_SIZE;
		this.subscribeTimeoutMs =
			config.subscribeTimeoutMs ?? SUBSCRIBE_TIMEOUT_MS;
	}

	/** Used by topic factories — not part of the app-facing API. */
	register(topic: RegisteredTopic): void {
		if (this.topics.some((existing) => existing.id === topic.id)) {
			throw new Error(`ws topic id already registered: ${topic.id}`);
		}
		this.topics.push(topic);
	}

	get factoryDeps(): FactoryDeps {
		return this.deps;
	}

	/**
	 * Publishes one event: egress-filtered against the topic schema, appended
	 * to the replay buffer, fanned out to current subscribers. Synchronous and
	 * loss-tolerant per connection — a broken socket drops its subscription,
	 * never the publish.
	 */
	publish<Event extends TSchema>(
		topic: WsTopicInstance<Event>,
		params: Readonly<Record<string, string>>,
		data: StaticEncode<Event>
	): void {
		const registered = this.topics.find(
			(candidate) => candidate.id === topic.id
		);
		if (registered === undefined) {
			throw new Error(`ws publish: unknown topic ${topic.id}`);
		}
		const concrete = fillTopic(registered.segments, params);
		const cleaned = registered.cleanEvent(data);
		const violation = registered.checkEvent(cleaned);
		if (violation !== null) {
			// A publish violating its own schema is a bug, same rule as route
			// responses (ADR-0005) — surface it, don't ship it.
			throw new Error(
				`ws topic ${topic.id} violated its event schema: ${violation}`
			);
		}
		const channel = this.channel(concrete);
		const eventId = channel.nextEventId;
		channel.nextEventId += 1;
		channel.entries.push({ eventId, data: cleaned });
		if (channel.entries.length > this.replaySize) {
			channel.entries.splice(0, channel.entries.length - this.replaySize);
		}
		this.deps.metrics.increment('ws_events_published_total', {
			topic: topic.id,
		});
		const frame: WsServerFrame = {
			type: 'event',
			topic: concrete,
			eventId,
			data: cleaned,
		};
		for (const [connectionId, subscriber] of channel.subscribers) {
			if (!subscriber.send(frame)) {
				channel.subscribers.delete(connectionId);
			}
		}
	}

	/** Binds one raw socket to the frame protocol. */
	connection(
		transport: WsConnectionTransport,
		info: WsConnectionInfo
	): WsConnection {
		const connectionId = this.deps.ids.requestId();
		const subscribed = new Set<string>();
		this.connections.set(connectionId, transport);
		this.deps.metrics.increment('ws_connections_total', {
			surface: this.surface,
		});

		const send = (frame: WsServerFrame): boolean => {
			try {
				transport.send(JSON.stringify(frame));
				return true;
			} catch {
				return false;
			}
		};

		const subscribe = async (
			frame: WsClientFrame & { type: 'subscribe' }
		): Promise<void> => {
			const concreteSegments = frame.topic.split('/');
			let matched: {
				topic: RegisteredTopic;
				params: Record<string, string>;
			} | null = null;
			for (const topic of this.topics) {
				const params = matchTopic(topic.segments, concreteSegments);
				if (params !== null) {
					matched = { topic, params };
					break;
				}
			}
			if (matched === null) {
				send({
					type: 'denied',
					topic: frame.topic,
					status: 404,
					code: 'UNKNOWN_TOPIC',
				});
				return;
			}

			// Subscribe IS the policy moment: one pipeline run per subscribe
			// frame, over the upgrade headers + topic params (ADR-0005).
			const requestId = this.deps.ids.requestId();
			const span = this.deps.tracer.startSpan(
				`ws-subscribe ${matched.topic.id}`,
				{
					remoteParent: info.headers['traceparent'],
					attributes: {
						'ws.topic': matched.topic.id,
						'route.surface': this.surface,
					},
				}
			);
			const log = this.deps.log.child({
				requestId,
				wsTopic: matched.topic.id,
				connectionId,
				...(span.traceId !== '' ? { traceId: span.traceId } : {}),
			});
			const controller = new AbortController();
			const timer = setTimeout(
				() => controller.abort(),
				this.subscribeTimeoutMs
			);
			try {
				const ctx: RequestContext = {
					requestId,
					surface: this.surface,
					routeId: matched.topic.id,
					headers: info.headers,
					ip: info.ip,
					traceparent: span.traceparent,
					traceId: span.traceId,
					rawParams: matched.params,
					rawQuery: {},
					rawBody: undefined,
					log,
					signal: controller.signal,
				};
				const decision = await matched.topic.authorize(ctx);
				if (!decision.ok) {
					log.info('ws subscribe denied', { code: decision.code });
					this.deps.metrics.increment('ws_subscribes_total', {
						topic: matched.topic.id,
						result: 'denied',
					});
					span.setStatus('error');
					send({
						type: 'denied',
						topic: frame.topic,
						status: decision.status,
						code: decision.code,
					});
					return;
				}
				const channel = this.channel(frame.topic);
				channel.subscribers.set(connectionId, { connectionId, send });
				subscribed.add(frame.topic);
				this.deps.metrics.increment('ws_subscribes_total', {
					topic: matched.topic.id,
					result: 'allowed',
				});
				span.setStatus('ok');
				send({ type: 'subscribed', topic: frame.topic });
				if (frame.lastEventId !== undefined) {
					for (const entry of channel.entries) {
						if (entry.eventId > frame.lastEventId) {
							send({
								type: 'event',
								topic: frame.topic,
								eventId: entry.eventId,
								data: entry.data,
							});
						}
					}
				}
			} catch (error) {
				log.error('ws subscribe failed', {
					error:
						error instanceof Error ? error.message : String(error),
				});
				span.recordError(error);
				this.deps.errorSink.capture(error, {
					entrypoint: 'ws-subscribe',
					requestId,
					route: matched.topic.id,
					traceId: span.traceId !== '' ? span.traceId : undefined,
				});
				send({
					type: 'denied',
					topic: frame.topic,
					status: 500,
					code: 'INTERNAL',
				});
			} finally {
				clearTimeout(timer);
				span.end();
			}
		};

		const onMessage = (raw: unknown): void => {
			const frame = parseClientFrame(raw);
			if (frame === null) {
				send({ type: 'error', code: 'MALFORMED_FRAME' });
				return;
			}
			if (frame.type === 'ping') {
				send({ type: 'pong' });
				return;
			}
			if (frame.type === 'unsubscribe') {
				this.channels
					.get(frame.topic)
					?.subscribers.delete(connectionId);
				subscribed.delete(frame.topic);
				send({ type: 'unsubscribed', topic: frame.topic });
				return;
			}
			void subscribe(frame);
		};

		const onClose = (): void => {
			this.connections.delete(connectionId);
			for (const topic of subscribed) {
				this.channels.get(topic)?.subscribers.delete(connectionId);
			}
			subscribed.clear();
		};

		return { id: connectionId, onMessage, onClose };
	}

	/**
	 * Graceful-shutdown drain (ADR-0014 #5, phase "disconnect clients"): tells
	 * every client the server is going away (resume hint frame, then WS close
	 * code 1012 "Service Restart") instead of letting sockets die with the
	 * process. Clients reconnect and resubscribe with `lastEventId`.
	 */
	closeAll(reason = 'server restarting'): void {
		for (const [connectionId, transport] of this.connections) {
			try {
				transport.send(
					JSON.stringify({
						type: 'shutdown',
						resume: 'lastEventId',
					} satisfies WsServerFrame)
				);
				transport.close(1012, reason);
			} catch {
				// The socket may already be gone — draining must not throw.
			}
			this.connections.delete(connectionId);
		}
		for (const channel of this.channels.values()) {
			channel.subscribers.clear();
		}
	}

	private channel(concreteTopic: string): TopicChannel {
		let channel = this.channels.get(concreteTopic);
		if (channel === undefined) {
			channel = { nextEventId: 1, entries: [], subscribers: new Map() };
			this.channels.set(concreteTopic, channel);
		}
		return channel;
	}
}

export function createWsHub(config: WsHubConfig): WsHub {
	return new WsHub(config);
}

export interface WsTopicFactoryConfig<
	Decl extends object,
	Provides extends object,
> {
	readonly hub: WsHub;
	/**
	 * The subscribe pipeline — typically the exact pipeline instance the
	 * surface's routes run, so a ws topic declares `policy:` (and friends)
	 * with identical semantics and identical stage implementations.
	 */
	readonly pipeline: Pipeline<RequestContext, Decl, Provides>;
}

export type WsTopicFactory<Decl extends object> = <Event extends TSchema>(
	def: WsTopicShape<Decl, Event> & Decl
) => WsTopicInstance<Event>;

/**
 * The only way to declare a ws topic. Registers on the hub; authorization of
 * every subscribe frame runs the given pipeline with the topic declaration —
 * omitting a stage's required field (e.g. `policy`) is a compile error,
 * exactly as on routes.
 */
export function createWsTopicFactory<
	Decl extends object,
	Provides extends object,
>(config: WsTopicFactoryConfig<Decl, Provides>): WsTopicFactory<Decl> {
	const { hub, pipeline } = config;

	return function wsTopic(def) {
		const segments = splitTopic(def.topic);
		const compiled = TypeCompiler.Compile(def.event);
		hub.register({
			id: def.id,
			segments,
			cleanEvent: (data) => Value.Clean(def.event, data),
			checkEvent: (data) => {
				if (compiled.Check(data)) return null;
				const first = compiled.Errors(data).First();
				return first === undefined
					? 'unknown mismatch'
					: `${first.path}: ${first.message}`;
			},
			authorize: async (ctx) => {
				const run = await pipeline.run(def, ctx, {
					tracer: hub.factoryDeps.tracer,
					observe: (stage, durationMs) => {
						hub.factoryDeps.metrics.observe(
							'ws_subscribe_stage_duration_ms',
							durationMs,
							{ topic: def.id, stage }
						);
					},
				});
				if (run.kind === 'halt') {
					return { ok: false, status: run.status, code: run.code };
				}
				return { ok: true };
			},
		});
		return { id: def.id, topic: def.topic, event: def.event };
	};
}
