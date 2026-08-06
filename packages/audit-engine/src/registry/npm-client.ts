import type {
	DistTags,
	NpmBulkAdvisoryResponse,
	Packument,
	PackumentVersion,
} from '../types';
import type { RegistryCacheEntry, RegistryCachePort } from './cache';

export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';
export const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json';

/** npm rejects oversized bulk bodies; 400 names per request stays well clear. */
export const BULK_ADVISORY_CHUNK_SIZE = 400;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export class RegistryError extends Error {
	readonly status: number;
	readonly url: string;
	readonly body?: string;

	constructor(
		message: string,
		options: { status: number; url: string; body?: string }
	) {
		super(message);
		this.name = 'RegistryError';
		this.status = options.status;
		this.url = options.url;
		this.body = options.body;
	}
}

export interface NpmClientOptions {
	/** Injected so tests never touch the network. */
	fetch: typeof fetch;
	cache?: RegistryCachePort;
	registryUrl?: string;
	/** Bearer token for private registries. */
	authToken?: string;
	/** TTL for dist-tags and for packuments without an ETag. Default 6h. */
	ttlMs?: number;
	/** Injectable clock (ms since epoch). */
	now?: () => number;
	/** Extra headers merged into every request. */
	headers?: Record<string, string>;
}

export interface NpmClient {
	getPackument(name: string): Promise<Packument>;
	getDistTags(name: string): Promise<DistTags>;
	getVersionManifest(
		name: string,
		version: string
	): Promise<PackumentVersion>;
	/**
	 * Publish timestamps per version (ISO strings), from the FULL packument's
	 * `time` map — the abbreviated document does not carry it. Only the
	 * extracted map is cached, never the multi-megabyte packument body.
	 */
	getPublishTimes(name: string): Promise<Record<string, string>>;
	bulkAdvisories(
		map: Record<string, string[]>
	): Promise<NpmBulkAdvisoryResponse>;
	packumentCacheKey(name: string): string;
	distTagsCacheKey(name: string): string;
	publishTimesCacheKey(name: string): string;
}

/** Registry-safe package name (`@scope/pkg` → `@scope%2fpkg`). */
export function encodePackageName(name: string): string {
	return name.replace(/\//g, '%2f');
}

/** Split a `{name: versions}` map into request-sized chunks. */
export function chunkAdvisoryMap(
	map: Record<string, string[]>,
	size: number = BULK_ADVISORY_CHUNK_SIZE
): Record<string, string[]>[] {
	const chunks: Record<string, string[]>[] = [];
	let current: Record<string, string[]> = {};
	let count = 0;
	for (const [name, versions] of Object.entries(map)) {
		if (!Array.isArray(versions) || versions.length === 0) continue;
		current[name] = [...new Set(versions)];
		count++;
		if (count >= size) {
			chunks.push(current);
			current = {};
			count = 0;
		}
	}
	if (count > 0) chunks.push(current);
	return chunks;
}

export function createNpmClient(options: NpmClientOptions): NpmClient {
	const {
		fetch: fetchImpl,
		cache,
		registryUrl = DEFAULT_REGISTRY_URL,
		authToken,
		ttlMs = SIX_HOURS_MS,
		now = () => Date.now(),
		headers: extraHeaders,
	} = options;

	const base = registryUrl.replace(/\/$/, '');

	const baseHeaders = (): Record<string, string> => {
		const headers: Record<string, string> = { ...extraHeaders };
		if (authToken !== undefined && authToken !== '') {
			headers.authorization = `Bearer ${authToken}`;
		}
		return headers;
	};

	const readCache = async (
		key: string
	): Promise<RegistryCacheEntry | null> => {
		if (cache === undefined) return null;
		return (await cache.get(key)) ?? null;
	};

	const writeCache = async (
		key: string,
		entry: RegistryCacheEntry
	): Promise<void> => {
		if (cache === undefined) return;
		await cache.set(key, entry);
	};

	const isFresh = (entry: RegistryCacheEntry | null): boolean => {
		if (entry === null || entry.expiresAt === undefined) return false;
		return Date.parse(entry.expiresAt) > now();
	};

	const timestamps = () => {
		const current = now();
		return {
			fetchedAt: new Date(current).toISOString(),
			expiresAt: new Date(current + ttlMs).toISOString(),
		};
	};

	async function conditionalGet<T>(
		url: string,
		cacheKey: string,
		accept: string
	): Promise<T> {
		const cached = await readCache(cacheKey);

		// Without an ETag the only protection against refetching is the TTL.
		// With an ETag, revalidation is nearly free, so always do it.
		if (cached !== null && cached.etag === undefined && isFresh(cached)) {
			return cached.body as T;
		}

		const headers = baseHeaders();
		headers.accept = accept;
		if (cached?.etag !== undefined) headers['if-none-match'] = cached.etag;

		const response = await fetchImpl(url, { method: 'GET', headers });

		if (response.status === 304 && cached !== null) {
			const stamps = timestamps();
			await writeCache(cacheKey, { ...cached, ...stamps });
			return cached.body as T;
		}

		if (!response.ok) {
			throw new RegistryError(
				`GET ${url} failed with ${response.status}`,
				{
					status: response.status,
					url,
					body: await safeText(response),
				}
			);
		}

		const body = (await response.json()) as T;
		const stamps = timestamps();
		await writeCache(cacheKey, {
			etag: response.headers.get('etag') ?? undefined,
			body,
			...stamps,
		});
		return body;
	}

	const packumentCacheKey = (name: string) => `npm:packument:${name}`;
	const distTagsCacheKey = (name: string) => `npm:dist-tags:${name}`;
	const publishTimesCacheKey = (name: string) => `npm:times:${name}`;

	return {
		packumentCacheKey,
		distTagsCacheKey,
		publishTimesCacheKey,

		async getPackument(name) {
			return conditionalGet<Packument>(
				`${base}/${encodePackageName(name)}`,
				packumentCacheKey(name),
				ABBREVIATED_ACCEPT
			);
		},

		async getDistTags(name) {
			return conditionalGet<DistTags>(
				`${base}/-/package/${encodePackageName(name)}/dist-tags`,
				distTagsCacheKey(name),
				'application/json'
			);
		},

		async getVersionManifest(name, version) {
			return conditionalGet<PackumentVersion>(
				`${base}/${encodePackageName(name)}/${encodeURIComponent(version)}`,
				`npm:version:${name}@${version}`,
				ABBREVIATED_ACCEPT
			);
		},

		async getPublishTimes(name) {
			// Not conditionalGet: that helper caches the response body, and a
			// FULL packument can be many megabytes. Extract `time` and cache
			// only that; the ETag still makes revalidation nearly free.
			const cacheKey = publishTimesCacheKey(name);
			const cached = await readCache(cacheKey);
			if (
				cached !== null &&
				cached.etag === undefined &&
				isFresh(cached)
			) {
				return cached.body as Record<string, string>;
			}

			const headers = baseHeaders();
			headers.accept = 'application/json';
			if (cached?.etag !== undefined) {
				headers['if-none-match'] = cached.etag;
			}

			const url = `${base}/${encodePackageName(name)}`;
			const response = await fetchImpl(url, { method: 'GET', headers });

			if (response.status === 304 && cached !== null) {
				await writeCache(cacheKey, { ...cached, ...timestamps() });
				return cached.body as Record<string, string>;
			}
			if (!response.ok) {
				throw new RegistryError(
					`GET ${url} failed with ${response.status}`,
					{
						status: response.status,
						url,
						body: await safeText(response),
					}
				);
			}

			const full = (await response.json()) as {
				time?: Record<string, string>;
			};
			const times: Record<string, string> = { ...(full.time ?? {}) };
			// `created`/`modified` are packument metadata, not versions.
			delete times.created;
			delete times.modified;

			await writeCache(cacheKey, {
				etag: response.headers.get('etag') ?? undefined,
				body: times,
				...timestamps(),
			});
			return times;
		},

		async bulkAdvisories(map) {
			const url = `${base}/-/npm/v1/security/advisories/bulk`;
			const merged: NpmBulkAdvisoryResponse = {};
			for (const chunk of chunkAdvisoryMap(map)) {
				const headers = baseHeaders();
				headers['content-type'] = 'application/json';
				headers.accept = 'application/json';
				const response = await fetchImpl(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(chunk),
				});
				if (!response.ok) {
					throw new RegistryError(
						`POST ${url} failed with ${response.status}`,
						{
							status: response.status,
							url,
							body: await safeText(response),
						}
					);
				}
				const payload =
					(await response.json()) as NpmBulkAdvisoryResponse;
				for (const [name, advisories] of Object.entries(
					payload ?? {}
				)) {
					if (!Array.isArray(advisories)) continue;
					const existing = merged[name];
					merged[name] =
						existing === undefined
							? advisories
							: [...existing, ...advisories];
				}
			}
			return merged;
		},
	};
}

async function safeText(response: Response): Promise<string | undefined> {
	try {
		return (await response.text()).slice(0, 2000);
	} catch {
		return undefined;
	}
}
