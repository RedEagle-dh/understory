import type { CachePort, LoggerPort, MetricsPort } from './ports';

/**
 * Port decorators (ADR-0005): applied exclusively in the composition root,
 * so services and handlers keep programming against the plain port. Cache
 * failures never fail the decorated call — the decorator falls through to
 * the source (fail-open), mirroring the rate limiter's stance.
 *
 * Composition order is withCache(withResilience(target)): cache hits
 * short-circuit before the breaker, so cached data keeps serving while the
 * source breaker is open, and breaker stats count only real source calls.
 */

export interface CacheEntry {
	readonly namespace: string;
	readonly key: string;
	readonly ttlSeconds: number;
}

/**
 * Method syntax (not arrow properties) is deliberate: it keeps concrete spec
 * instantiations assignable to the loosened internal view without casts.
 */
export interface CacheReadSpec<A extends readonly unknown[], R> {
	readonly kind: 'read';
	/** Where the result lives. Namespace must carry the tenant (ADR-0003). */
	entry(...args: A): CacheEntry;
	/** Validates a raw cache value; `undefined` = treat as miss and refetch. */
	decode(raw: unknown): R | undefined;
	/** Skip caching volatile results (e.g. metered entitlements). Default: cache. */
	cacheIf?(result: R): boolean;
}

export interface CacheWriteSpec<A extends readonly unknown[]> {
	readonly kind: 'write';
	/** Namespaces to invalidate after the write succeeds (delete-on-write). */
	invalidates(...args: A): readonly string[];
}

export type CacheMethodSpec<F> = F extends (
	...args: infer A
) => Promise<infer R>
	? CacheReadSpec<A, R> | CacheWriteSpec<A>
	: never;

export type CacheSpec<TPort extends object> = {
	readonly [M in keyof TPort]?: CacheMethodSpec<TPort[M]>;
};

export function cacheRead<A extends readonly unknown[], R>(spec: {
	entry(...args: A): CacheEntry;
	decode(raw: unknown): R | undefined;
	cacheIf?(result: R): boolean;
}): CacheReadSpec<A, R> {
	return { kind: 'read', ...spec };
}

export function cacheWrite<A extends readonly unknown[]>(spec: {
	invalidates(...args: A): readonly string[];
}): CacheWriteSpec<A> {
	return { kind: 'write', ...spec };
}

export interface WithCacheOptions<TPort extends object> {
	readonly target: TPort;
	readonly cache: CachePort;
	readonly spec: CacheSpec<TPort>;
	readonly metrics: MetricsPort;
	readonly log: LoggerPort;
	/** Port name for metrics/log labels — low-cardinality, never a tenant id. */
	readonly name: string;
}

type LooseReadSpec = CacheReadSpec<readonly unknown[], unknown>;
type LooseWriteSpec = CacheWriteSpec<readonly unknown[]>;
type LooseMethodSpec = LooseReadSpec | LooseWriteSpec;

function isLooseMethodSpec(value: unknown): value is LooseMethodSpec {
	if (typeof value !== 'object' || value === null) return false;
	const record: Record<PropertyKey, unknown> = { ...value };
	if (record.kind === 'read') {
		return (
			typeof record.entry === 'function' &&
			typeof record.decode === 'function'
		);
	}
	if (record.kind === 'write') {
		return typeof record.invalidates === 'function';
	}
	return false;
}

/** Calls a method value with a declared-unknown result — no `any` leaks out. */
function invoke(
	fn: unknown,
	thisArg: unknown,
	args: readonly unknown[]
): unknown {
	if (typeof fn !== 'function') {
		throw new TypeError('decorated member is not a function');
	}
	return Reflect.apply(fn, thisArg, [...args]);
}

function specEntries(spec: object): Map<PropertyKey, LooseMethodSpec> {
	const entries = new Map<PropertyKey, LooseMethodSpec>();
	for (const key of Reflect.ownKeys(spec)) {
		const value: unknown = Reflect.get(spec, key);
		if (isLooseMethodSpec(value)) entries.set(key, value);
	}
	return entries;
}

/**
 * Wraps the spec'd read methods with get-through caching and the spec'd write
 * methods with namespace invalidation after success. Non-spec'd members pass
 * through untouched (Proxy — class prototype methods survive).
 */
export function withCache<TPort extends object>(
	options: WithCacheOptions<TPort>
): TPort {
	const { cache, metrics, log, name } = options;
	const entries = specEntries(options.spec);
	const wrappers = new Map<PropertyKey, unknown>();

	const countEvent = (method: string, outcome: string): void => {
		metrics.increment('port_cache_events_total', {
			port: name,
			method,
			outcome,
		});
	};
	const countError = (method: string, op: string, error: unknown): void => {
		metrics.increment('port_cache_errors_total', {
			port: name,
			method,
			op,
		});
		log.warn('cache unavailable — falling through to source', {
			port: name,
			method,
			op,
			error: error instanceof Error ? error.message : String(error),
		});
	};

	const runRead = async (
		method: string,
		spec: LooseReadSpec,
		original: unknown,
		thisArg: unknown,
		args: readonly unknown[]
	): Promise<unknown> => {
		const startedAt = performance.now();
		const entry = spec.entry(...args);
		let raw: unknown;
		try {
			raw = await cache.get(entry.namespace, entry.key);
		} catch (error) {
			countError(method, 'get', error);
		}
		if (raw !== undefined) {
			const decoded = spec.decode(raw);
			if (decoded !== undefined) {
				countEvent(method, 'hit');
				metrics.observe(
					'port_cache_read_ms',
					performance.now() - startedAt,
					{ port: name, method, outcome: 'hit' }
				);
				return decoded;
			}
			countEvent(method, 'stale_decode');
		}
		const result: unknown = await invoke(original, thisArg, args);
		countEvent(method, 'miss');
		const shouldCache = spec.cacheIf === undefined || spec.cacheIf(result);
		if (result !== undefined && shouldCache) {
			try {
				await cache.set(
					entry.namespace,
					entry.key,
					result,
					entry.ttlSeconds
				);
			} catch (error) {
				countError(method, 'set', error);
			}
		}
		metrics.observe('port_cache_read_ms', performance.now() - startedAt, {
			port: name,
			method,
			outcome: 'miss',
		});
		return result;
	};

	const runWrite = async (
		method: string,
		spec: LooseWriteSpec,
		original: unknown,
		thisArg: unknown,
		args: readonly unknown[]
	): Promise<unknown> => {
		const result: unknown = await invoke(original, thisArg, args);
		for (const namespace of spec.invalidates(...args)) {
			try {
				await cache.invalidateNamespace(namespace);
				metrics.increment('port_cache_invalidations_total', {
					port: name,
					method,
				});
			} catch (error) {
				countError(method, 'invalidate', error);
			}
		}
		return result;
	};

	return new Proxy(options.target, {
		get(target, prop, receiver) {
			const spec = entries.get(prop);
			const value: unknown = Reflect.get(target, prop, receiver);
			if (spec === undefined || typeof value !== 'function') {
				return value;
			}
			let wrapper = wrappers.get(prop);
			if (wrapper === undefined) {
				const method = String(prop);
				wrapper =
					spec.kind === 'read'
						? (...args: readonly unknown[]) =>
								runRead(method, spec, value, target, args)
						: (...args: readonly unknown[]) =>
								runWrite(method, spec, value, target, args);
				wrappers.set(prop, wrapper);
			}
			return wrapper;
		},
	});
}
