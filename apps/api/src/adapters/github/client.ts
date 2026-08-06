import { GithubError } from '../../errors';
import type { RegistryCacheStore } from '../../stores/registry-cache';

export interface GithubClientOptions {
	apiUrl: string;
	token?: string;
	cache?: RegistryCacheStore;
	fetchImpl?: typeof fetch;
	/** Defer non-critical work when the remaining core quota drops below this. */
	lowQuotaThreshold?: number;
}

export interface GithubResponse<T> {
	body: T;
	fromCache: boolean;
	rateLimitRemaining?: number;
}

export class GithubHttpError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
		message: string
	) {
		super(`GitHub ${status} on ${url}: ${message}`);
	}
}

/**
 * Thin GitHub REST client: auth header, ETag caching (304s cost no rate-limit
 * quota), rate-limit header tracking, single retry on 5xx/secondary-rate-limit.
 */
export function createGithubClient(options: GithubClientOptions) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const lowQuota = options.lowQuotaThreshold ?? 200;
	let remaining: number | undefined;

	async function request<T>(
		path: string,
		init: {
			method?: string;
			accept?: string;
			cacheKey?: string;
			cacheTtlMs?: number;
			body?: unknown;
			raw?: boolean;
		} = {}
	): Promise<GithubResponse<T>> {
		const url = path.startsWith('http') ? path : `${options.apiUrl}${path}`;
		const headers: Record<string, string> = {
			accept: init.accept ?? 'application/vnd.github+json',
			'user-agent': 'understory',
			'x-github-api-version': '2022-11-28',
		};
		if (options.token !== undefined && options.token !== '') {
			headers.authorization = `Bearer ${options.token}`;
		}

		const cached =
			init.cacheKey !== undefined && options.cache !== undefined
				? await options.cache.get(init.cacheKey)
				: null;
		if (cached?.etag !== undefined) headers['if-none-match'] = cached.etag;

		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: init.method ?? 'GET',
				headers,
				body:
					init.body === undefined
						? undefined
						: JSON.stringify(init.body),
			});
		} catch (error) {
			throw new GithubError(
				`network failure: ${error instanceof Error ? error.message : String(error)}`
			);
		}

		if (response.status >= 500 || response.status === 429) {
			response = await fetchImpl(url, {
				method: init.method ?? 'GET',
				headers,
				body:
					init.body === undefined
						? undefined
						: JSON.stringify(init.body),
			});
		}

		const remainingHeader = response.headers.get('x-ratelimit-remaining');
		if (remainingHeader !== null) remaining = Number(remainingHeader);

		if (response.status === 304 && cached !== null) {
			if (init.cacheKey !== undefined && options.cache !== undefined) {
				await options.cache.set(init.cacheKey, {
					...cached,
					fetchedAt: new Date(),
					expiresAt: new Date(
						Date.now() + (init.cacheTtlMs ?? 3_600_000)
					),
				});
			}
			return {
				body: (init.raw === true
					? cached.body
					: JSON.parse(cached.body)) as T,
				fromCache: true,
				rateLimitRemaining: remaining,
			};
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new GithubHttpError(response.status, url, text.slice(0, 300));
		}

		const text = await response.text();
		const etag = response.headers.get('etag') ?? undefined;
		if (init.cacheKey !== undefined && options.cache !== undefined) {
			await options.cache.set(init.cacheKey, {
				etag,
				body: text,
				fetchedAt: new Date(),
				expiresAt: new Date(
					Date.now() + (init.cacheTtlMs ?? 3_600_000)
				),
			});
		}
		return {
			body: (init.raw === true ? text : JSON.parse(text)) as T,
			fromCache: false,
			rateLimitRemaining: remaining,
		};
	}

	return {
		request,
		/** True when the token's remaining core quota is low — defer non-critical scans. */
		isQuotaLow: () => remaining !== undefined && remaining < lowQuota,
		rateLimitRemaining: () => remaining,
	};
}

export type GithubClient = ReturnType<typeof createGithubClient>;
