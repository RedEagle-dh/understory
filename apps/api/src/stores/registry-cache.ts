import { type Db, schema } from '@workspace/db';
import { eq, lt } from 'drizzle-orm';

export interface CacheEntry {
	etag?: string;
	body: string;
	fetchedAt: Date;
	expiresAt: Date;
}

/**
 * SQLite-backed HTTP cache for registry packuments / dist-tags / GitHub
 * responses. Callers decide TTL; expired entries are still returned (the
 * caller revalidates with the stored ETag — a 304 refreshes them for free).
 */
export interface RegistryCacheStore {
	get(key: string): Promise<CacheEntry | null>;
	set(key: string, entry: CacheEntry): Promise<void>;
	pruneExpired(olderThan: Date): Promise<number>;
}

export function createRegistryCacheStore(db: Db): RegistryCacheStore {
	return {
		async get(key) {
			const row = await db.query.registryCache.findFirst({
				where: eq(schema.registryCache.key, key),
			});
			if (row === undefined || row.bodyJson === null) return null;
			return {
				etag: row.etag ?? undefined,
				body: row.bodyJson,
				fetchedAt: row.fetchedAt,
				expiresAt: row.expiresAt,
			};
		},
		async set(key, entry) {
			await db
				.insert(schema.registryCache)
				.values({
					key,
					etag: entry.etag ?? null,
					bodyJson: entry.body,
					fetchedAt: entry.fetchedAt,
					expiresAt: entry.expiresAt,
				})
				.onConflictDoUpdate({
					target: schema.registryCache.key,
					set: {
						etag: entry.etag ?? null,
						bodyJson: entry.body,
						fetchedAt: entry.fetchedAt,
						expiresAt: entry.expiresAt,
					},
				});
		},
		async pruneExpired(olderThan) {
			const deleted = await db
				.delete(schema.registryCache)
				.where(lt(schema.registryCache.expiresAt, olderThan))
				.returning({ key: schema.registryCache.key });
			return deleted.length;
		},
	};
}
