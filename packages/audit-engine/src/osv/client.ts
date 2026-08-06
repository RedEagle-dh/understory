import type { OsvBatchResult, OsvVuln } from '../types';

export const DEFAULT_OSV_URL = 'https://api.osv.dev';

/** OSV documents a 1000-query cap; 250 keeps bodies small and latency low. */
export const OSV_BATCH_CHUNK_SIZE = 250;

export class OsvError extends Error {
	readonly status: number;
	readonly url: string;
	readonly body?: string;

	constructor(
		message: string,
		options: { status: number; url: string; body?: string }
	) {
		super(message);
		this.name = 'OsvError';
		this.status = options.status;
		this.url = options.url;
		this.body = options.body;
	}
}

export interface OsvPackageVersion {
	name: string;
	version: string;
}

export interface OsvClientOptions {
	fetch: typeof fetch;
	baseUrl?: string;
	/** Queries per `/v1/querybatch` request. Default 250. */
	chunkSize?: number;
	headers?: Record<string, string>;
}

export interface OsvClient {
	/** Results are returned in the same order as `pairs`. */
	queryBatch(pairs: readonly OsvPackageVersion[]): Promise<OsvBatchResult[]>;
	getVuln(id: string): Promise<OsvVuln>;
}

interface RawBatchResponse {
	results?: ({
		vulns?: { id?: string; modified?: string }[];
		next_page_token?: string;
	} | null)[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

export function createOsvClient(options: OsvClientOptions): OsvClient {
	const {
		fetch: fetchImpl,
		baseUrl = DEFAULT_OSV_URL,
		chunkSize = OSV_BATCH_CHUNK_SIZE,
		headers: extraHeaders,
	} = options;
	const base = baseUrl.replace(/\/$/, '');

	return {
		async queryBatch(pairs) {
			if (pairs.length === 0) return [];
			const out: OsvBatchResult[] = [];
			const url = `${base}/v1/querybatch`;

			for (const group of chunk(pairs, Math.max(1, chunkSize))) {
				const response = await fetchImpl(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json',
						...extraHeaders,
					},
					body: JSON.stringify({
						queries: group.map((pair) => ({
							package: { name: pair.name, ecosystem: 'npm' },
							version: pair.version,
						})),
					}),
				});
				if (!response.ok) {
					throw new OsvError(
						`POST ${url} failed with ${response.status}`,
						{
							status: response.status,
							url,
							body: await safeText(response),
						}
					);
				}
				const payload = (await response.json()) as RawBatchResponse;
				const results = Array.isArray(payload?.results)
					? payload.results
					: [];
				// A no-hit query is returned as `{}`; missing trailing entries are
				// padded so the output always lines up with the input.
				for (let index = 0; index < group.length; index++) {
					const entry = results[index];
					const vulns = Array.isArray(entry?.vulns)
						? entry.vulns
						: [];
					out.push({
						vulns: vulns
							.filter(
								(
									vuln
								): vuln is { id: string; modified?: string } =>
									typeof vuln?.id === 'string'
							)
							.map((vuln) => ({
								id: vuln.id,
								modified: vuln.modified,
							})),
						nextPageToken: entry?.next_page_token,
					});
				}
			}

			return out;
		},

		async getVuln(id) {
			const url = `${base}/v1/vulns/${encodeURIComponent(id)}`;
			const response = await fetchImpl(url, {
				method: 'GET',
				headers: { accept: 'application/json', ...extraHeaders },
			});
			if (!response.ok) {
				throw new OsvError(
					`GET ${url} failed with ${response.status}`,
					{
						status: response.status,
						url,
						body: await safeText(response),
					}
				);
			}
			return (await response.json()) as OsvVuln;
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
