export interface RegistryCacheEntry {
	/** ETag as returned by the registry; enables conditional requests. */
	etag?: string;
	/** The parsed JSON body. */
	body: unknown;
	/** ISO timestamp of the last successful (re)validation. */
	fetchedAt: string;
	/** ISO timestamp after which the entry must be revalidated. */
	expiresAt?: string;
}

/**
 * Storage port for registry responses. The API app implements this against the
 * `registry_cache` table; {@link createMemoryCache} covers tests.
 */
export interface RegistryCachePort {
	get(
		key: string
	): Promise<RegistryCacheEntry | null> | RegistryCacheEntry | null;
	set(key: string, entry: RegistryCacheEntry): Promise<void> | void;
}

export interface MemoryCache extends RegistryCachePort {
	get(key: string): RegistryCacheEntry | null;
	set(key: string, entry: RegistryCacheEntry): void;
	delete(key: string): void;
	clear(): void;
	readonly size: number;
	keys(): string[];
}

/** In-memory {@link RegistryCachePort}, primarily for tests and dry runs. */
export function createMemoryCache(
	initial?: Iterable<readonly [string, RegistryCacheEntry]>
): MemoryCache {
	const store = new Map<string, RegistryCacheEntry>(initial);
	return {
		get(key) {
			return store.get(key) ?? null;
		},
		set(key, entry) {
			store.set(key, entry);
		},
		delete(key) {
			store.delete(key);
		},
		clear() {
			store.clear();
		},
		get size() {
			return store.size;
		},
		keys() {
			return [...store.keys()];
		},
	};
}
