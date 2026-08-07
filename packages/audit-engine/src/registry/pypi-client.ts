import { normalizePypiName } from '../pep440';
import type { RegistryCacheEntry, RegistryCachePort } from './cache';
import { RegistryError } from './npm-client';

export const DEFAULT_PYPI_URL = 'https://pypi.org';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export interface PypiRelease {
	version: string;
	/** True when every file of the release is yanked (pip's rule). */
	yanked: boolean;
	yankedReason?: string;
	/** Earliest file upload time, ISO 8601. Undefined for releases with no files. */
	uploadedAt?: string;
}

export interface PypiProject {
	/** PEP 503 normalized project name. */
	name: string;
	/** `info.version` — PyPI's "latest" (excludes yanked/prereleases per PyPI rules). */
	latest?: string;
	releases: PypiRelease[];
}

export interface PypiClientOptions {
	/** Injected so tests never touch the network. */
	fetch: typeof fetch;
	cache?: RegistryCachePort;
	baseUrl?: string;
	/** TTL for entries without an ETag. Default 6h. */
	ttlMs?: number;
	/** Injectable clock (ms since epoch). */
	now?: () => number;
	/** Extra headers merged into every request. */
	headers?: Record<string, string>;
}

export interface PypiClient {
	getProject(name: string): Promise<PypiProject>;
	/** version -> earliest upload ISO time, derived from the same fetch/cache. */
	getPublishTimes(name: string): Promise<Record<string, string>>;
	projectCacheKey(name: string): string;
}

/** One file entry of a `releases["<version>"]` array, as PyPI serves it. */
interface PypiRawFile {
	upload_time_iso_8601?: string;
	yanked?: boolean;
	yanked_reason?: string | null;
}

interface PypiRawProject {
	info?: { version?: string };
	releases?: Record<string, PypiRawFile[]>;
}

/**
 * Collapse a release's file list into the normalized {@link PypiRelease}.
 * pip considers a release yanked only when EVERY file is yanked; a release
 * with no files is not yanked and carries no upload time.
 */
function normalizeRelease(version: string, files: PypiRawFile[]): PypiRelease {
	const yanked =
		files.length > 0 && files.every((file) => Boolean(file.yanked));

	let yankedReason: string | undefined;
	for (const file of files) {
		if (
			typeof file.yanked_reason === 'string' &&
			file.yanked_reason !== ''
		) {
			yankedReason = file.yanked_reason;
			break;
		}
	}

	let uploadedAt: string | undefined;
	let uploadedAtMs = Number.POSITIVE_INFINITY;
	for (const file of files) {
		const iso = file.upload_time_iso_8601;
		if (typeof iso !== 'string') continue;
		const parsed = Date.parse(iso);
		if (Number.isNaN(parsed)) continue;
		if (parsed < uploadedAtMs) {
			uploadedAtMs = parsed;
			uploadedAt = iso;
		}
	}

	const release: PypiRelease = { version, yanked };
	if (yankedReason !== undefined) release.yankedReason = yankedReason;
	if (uploadedAt !== undefined) release.uploadedAt = uploadedAt;
	return release;
}

/**
 * Shrink PyPI's raw JSON (a dict of per-version file lists, tens of MB for
 * big projects) into the small {@link PypiProject}. Versions are kept as-is:
 * invalid PEP 440 strings are the versioning layer's concern, not ours.
 */
function normalizeProject(name: string, raw: PypiRawProject): PypiProject {
	const releases: PypiRelease[] = [];
	for (const [version, files] of Object.entries(raw.releases ?? {})) {
		if (version === '') continue;
		releases.push(
			normalizeRelease(version, Array.isArray(files) ? files : [])
		);
	}
	const latest = raw.info?.version;
	return {
		name,
		latest: latest === undefined || latest === '' ? undefined : latest,
		releases,
	};
}

export function createPypiClient(options: PypiClientOptions): PypiClient {
	const {
		fetch: fetchImpl,
		cache,
		baseUrl = DEFAULT_PYPI_URL,
		ttlMs = SIX_HOURS_MS,
		now = () => Date.now(),
		headers: extraHeaders,
	} = options;

	const base = baseUrl.replace(/\/$/, '');

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

	const projectCacheKey = (name: string) =>
		`pypi:project:${normalizePypiName(name)}`;

	async function getProject(name: string): Promise<PypiProject> {
		// Not the npm client's conditionalGet: that helper caches the raw
		// response body, and PyPI's JSON can be tens of megabytes (torch).
		// Normalize first and cache ONLY the small shape; the ETag still
		// makes revalidation nearly free.
		const normalized = normalizePypiName(name);
		const cacheKey = projectCacheKey(normalized);
		const cached = await readCache(cacheKey);

		// Without an ETag the only protection against refetching is the TTL.
		// With an ETag, revalidation is nearly free, so always do it.
		if (cached !== null && cached.etag === undefined && isFresh(cached)) {
			return cached.body as PypiProject;
		}

		const headers: Record<string, string> = { ...extraHeaders };
		headers.accept = 'application/json';
		if (cached?.etag !== undefined) headers['if-none-match'] = cached.etag;

		const url = `${base}/pypi/${normalized}/json`;
		const response = await fetchImpl(url, { method: 'GET', headers });

		if (response.status === 304 && cached !== null) {
			await writeCache(cacheKey, { ...cached, ...timestamps() });
			return cached.body as PypiProject;
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

		const raw = (await response.json()) as PypiRawProject;
		const project = normalizeProject(normalized, raw);

		await writeCache(cacheKey, {
			etag: response.headers.get('etag') ?? undefined,
			body: project,
			...timestamps(),
		});
		return project;
	}

	return {
		projectCacheKey,
		getProject,

		async getPublishTimes(name) {
			const project = await getProject(name);
			const times: Record<string, string> = {};
			for (const release of project.releases) {
				if (release.uploadedAt !== undefined) {
					times[release.version] = release.uploadedAt;
				}
			}
			return times;
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
