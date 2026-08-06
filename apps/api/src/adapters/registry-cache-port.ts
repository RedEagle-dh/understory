import type {
	RegistryCacheEntry,
	RegistryCachePort,
} from '@workspace/audit-engine';
import type { RegistryCacheStore } from '../stores/registry-cache';

/** Fallback TTL when the engine stores an entry without an explicit expiry. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Adapts the SQLite `registry_cache` table (Date timestamps, string bodies) to
 * the engine's {@link RegistryCachePort} (ISO timestamps, parsed JSON bodies).
 * Keeping the translation here means neither side has to know about the other.
 */
export function createRegistryCachePort(
	store: RegistryCacheStore
): RegistryCachePort {
	return {
		async get(key: string): Promise<RegistryCacheEntry | null> {
			const entry = await store.get(key);
			if (entry === null) return null;
			let body: unknown;
			try {
				body = JSON.parse(entry.body);
			} catch {
				// A body we cannot parse is a cache miss, not a scan failure.
				return null;
			}
			return {
				etag: entry.etag,
				body,
				fetchedAt: entry.fetchedAt.toISOString(),
				expiresAt: entry.expiresAt.toISOString(),
			};
		},
		async set(key: string, entry: RegistryCacheEntry): Promise<void> {
			const fetchedAt = new Date(
				Date.parse(entry.fetchedAt) || Date.now()
			);
			const expiresAt =
				entry.expiresAt === undefined
					? new Date(fetchedAt.getTime() + DEFAULT_TTL_MS)
					: new Date(
							Date.parse(entry.expiresAt) ||
								fetchedAt.getTime() + DEFAULT_TTL_MS
						);
			await store.set(key, {
				etag: entry.etag,
				body: JSON.stringify(entry.body),
				fetchedAt,
				expiresAt,
			});
		},
	};
}
