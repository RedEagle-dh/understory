import type { GithubClient } from './client';

export interface RepoRef {
	owner: string;
	repo: string;
	/** '' = use the repository's default branch. */
	branch: string;
}

export interface RepoFile {
	path: string;
	content: string;
}

export interface RepoSnapshot {
	branch: string;
	commitSha: string;
	files: RepoFile[];
	warnings: string[];
}

const MANIFEST_NAMES = new Set([
	'package.json',
	'package-lock.json',
	'bun.lock',
	'yarn.lock',
	'pnpm-lock.yaml',
	'pyproject.toml',
	'uv.lock',
	'poetry.lock',
	'requirements.txt',
]);

const EXCLUDED_PATH_SEGMENTS = [
	'node_modules/',
	'.venv/',
	'site-packages/',
	'/fixtures/',
	'/__tests__/',
	'/__fixtures__/',
	'/test/fixtures/',
];

const MAX_MANIFESTS = 100;
const BLOB_CONCURRENCY = 5;

interface RepoInfo {
	default_branch: string;
}

interface CommitInfo {
	sha: string;
}

interface TreeResponse {
	truncated: boolean;
	tree: { path: string; type: string; size?: number }[];
}

function isManifestPath(path: string): boolean {
	const name = path.split('/').at(-1) ?? '';
	if (!MANIFEST_NAMES.has(name)) return false;
	const slashed = `/${path}`;
	return !EXCLUDED_PATH_SEGMENTS.some((segment) => slashed.includes(segment));
}

/**
 * Reads everything a scan needs from GitHub in as few calls as possible:
 * repo info (only when the default branch must be resolved) → head commit →
 * one recursive tree listing → raw blob fetches for matching manifests.
 * All requests go through the ETag-caching client, so unchanged repos cost
 * almost no rate-limit quota.
 */
export function createRepoReader(client: GithubClient) {
	async function resolveBranch(ref: RepoRef): Promise<string> {
		if (ref.branch !== '') return ref.branch;
		const info = await client.request<RepoInfo>(
			`/repos/${ref.owner}/${ref.repo}`,
			{
				cacheKey: `gh:repo:${ref.owner}/${ref.repo}`,
				cacheTtlMs: 3_600_000,
			}
		);
		return info.body.default_branch;
	}

	async function headSha(ref: RepoRef, branch: string): Promise<string> {
		const commit = await client.request<CommitInfo>(
			`/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(branch)}`,
			{
				cacheKey: `gh:head:${ref.owner}/${ref.repo}@${branch}`,
				cacheTtlMs: 300_000,
			}
		);
		return commit.body.sha;
	}

	async function listManifestPaths(
		ref: RepoRef,
		sha: string,
		configuredPaths: string[] | null
	): Promise<{ paths: string[]; warnings: string[] }> {
		const warnings: string[] = [];
		const tree = await client.request<TreeResponse>(
			`/repos/${ref.owner}/${ref.repo}/git/trees/${sha}?recursive=1`,
			{
				cacheKey: `gh:tree:${ref.owner}/${ref.repo}@${sha}`,
				cacheTtlMs: 86_400_000,
			}
		);

		let paths: string[];
		if (tree.body.truncated) {
			warnings.push(
				'git tree listing was truncated; falling back to configured/root manifests'
			);
			paths = configuredPaths ?? [
				'package.json',
				'package-lock.json',
				'bun.lock',
			];
		} else {
			paths = tree.body.tree
				.filter(
					(entry) =>
						entry.type === 'blob' && isManifestPath(entry.path)
				)
				.map((entry) => entry.path);
			if (configuredPaths !== null) {
				const configured = new Set(configuredPaths);
				paths = paths.filter((path) => configured.has(path));
			}
		}

		if (paths.length > MAX_MANIFESTS) {
			warnings.push(
				`repository has ${paths.length} manifests; scanning the first ${MAX_MANIFESTS}`
			);
			paths = paths.slice(0, MAX_MANIFESTS);
		}
		return { paths, warnings };
	}

	async function fetchBlobs(
		ref: RepoRef,
		sha: string,
		paths: string[]
	): Promise<{ files: RepoFile[]; warnings: string[] }> {
		const files: RepoFile[] = [];
		const warnings: string[] = [];
		let index = 0;

		async function worker(): Promise<void> {
			while (index < paths.length) {
				const path = paths[index];
				index += 1;
				if (path === undefined) break;
				try {
					// The raw media type streams file content directly and, unlike
					// the JSON object media type, keeps working above 1 MB — real
					// package-lock.json files exceed that routinely.
					const file = await client.request<string>(
						`/repos/${ref.owner}/${ref.repo}/contents/${encodePath(path)}?ref=${sha}`,
						{
							accept: 'application/vnd.github.raw+json',
							cacheKey: `gh:blob:${ref.owner}/${ref.repo}@${sha}:${path}`,
							cacheTtlMs: 86_400_000,
							raw: true,
						}
					);
					files.push({ path, content: file.body });
				} catch (error) {
					warnings.push(
						`failed to fetch ${path}: ${error instanceof Error ? error.message : String(error)}`
					);
				}
			}
		}

		await Promise.all(
			Array.from(
				{ length: Math.min(BLOB_CONCURRENCY, paths.length) },
				() => worker()
			)
		);
		return { files, warnings };
	}

	return {
		resolveBranch,
		/**
		 * Branch + detected manifest paths without fetching a single blob —
		 * what `projects.testConnection` needs to report a repo is usable.
		 */
		async listManifests(
			ref: RepoRef,
			configuredPaths: string[] | null = null
		): Promise<{ branch: string; commitSha: string; paths: string[] }> {
			const branch = await resolveBranch(ref);
			const sha = await headSha(ref, branch);
			const { paths } = await listManifestPaths(
				ref,
				sha,
				configuredPaths
			);
			return { branch, commitSha: sha, paths };
		},
		async snapshot(
			ref: RepoRef,
			configuredPaths: string[] | null
		): Promise<RepoSnapshot> {
			const branch = await resolveBranch(ref);
			const sha = await headSha(ref, branch);
			const { paths, warnings } = await listManifestPaths(
				ref,
				sha,
				configuredPaths
			);
			const blobs = await fetchBlobs(ref, sha, paths);
			return {
				branch,
				commitSha: sha,
				files: blobs.files,
				warnings: [...warnings, ...blobs.warnings],
			};
		},
	};
}

function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

export type RepoReader = ReturnType<typeof createRepoReader>;
