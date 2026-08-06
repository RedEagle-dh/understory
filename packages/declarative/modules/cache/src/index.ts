import type { CachePort } from '@declarativejs/core';

interface Entry {
	readonly value: unknown;
	readonly expiresAt: number;
}

export interface MemoryCacheOptions {
	/** Injectable clock (ms epoch) for deterministic TTL testing. */
	readonly now?: () => number;
}

/**
 * An in-memory CachePort. Namespace invalidation bumps a per-namespace
 * generation so every prior key becomes unreachable in O(1) (delete-on-write
 * invalidation, matching the Redis adapter's contract). Suitable for single
 * process / tests; swap `createRedisCache` (same CachePort) for multi-instance.
 */
export function createMemoryCache(options: MemoryCacheOptions = {}): CachePort {
	const now = options.now ?? (() => Date.now());
	const store = new Map<string, Entry>();
	const generations = new Map<string, number>();
	const generation = (namespace: string): number =>
		generations.get(namespace) ?? 0;
	const fullKey = (namespace: string, key: string): string =>
		`${generation(namespace)}:${namespace}:${key}`;

	return {
		get(namespace, key) {
			const entry = store.get(fullKey(namespace, key));
			if (entry === undefined) return Promise.resolve(undefined);
			if (entry.expiresAt <= now()) {
				store.delete(fullKey(namespace, key));
				return Promise.resolve(undefined);
			}
			return Promise.resolve(entry.value);
		},
		set(namespace, key, value, ttlSeconds) {
			store.set(fullKey(namespace, key), {
				value,
				expiresAt: now() + ttlSeconds * 1000,
			});
			return Promise.resolve();
		},
		delete(namespace, key) {
			store.delete(fullKey(namespace, key));
			return Promise.resolve();
		},
		invalidateNamespace(namespace) {
			generations.set(namespace, generation(namespace) + 1);
			return Promise.resolve();
		},
	};
}
