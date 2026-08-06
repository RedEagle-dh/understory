import { type GithubClient, GithubHttpError } from './client';

/**
 * The Git Data half of the GitHub API — the only way to land several files in
 * ONE commit. (The Contents API writes one commit per file, which would make a
 * `package.json` + `package-lock.json` bump look like two unrelated changes and
 * break bisects.)
 *
 * Every method here is deliberately cache-free: the ETag cache is for scan
 * reads, and a PR write must never act on a 304'd branch head.
 */

export interface TreeFile {
	path: string;
	sha: string;
}

export interface PullSummary {
	number: number;
	url: string;
}

export interface PullState {
	number: number;
	state: 'open' | 'closed';
	merged: boolean;
	mergedAt: Date | null;
	closedAt: Date | null;
	url: string;
}

export interface RepoTarget {
	owner: string;
	repo: string;
}

interface RefResponse {
	object: { sha: string };
}

interface CommitResponse {
	sha: string;
	tree: { sha: string };
}

interface BlobResponse {
	sha: string;
}

interface TreeResponse {
	sha: string;
}

interface PullResponse {
	number: number;
	html_url: string;
	state: 'open' | 'closed';
	merged?: boolean;
	merged_at?: string | null;
	closed_at?: string | null;
}

/** GitHub answers 422 for both "already exists" cases; the text disambiguates. */
function is422With(error: unknown, fragment: string): boolean {
	return (
		error instanceof GithubHttpError &&
		error.status === 422 &&
		error.message.toLowerCase().includes(fragment.toLowerCase())
	);
}

function parseDate(value: string | null | undefined): Date | null {
	if (value === undefined || value === null || value === '') return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * Ref names carry meaningful slashes (`understory/security-abc123`), so each
 * SEGMENT is escaped rather than the whole string — `encodeURIComponent` on
 * the ref would turn it into `understory%2F…`, which GitHub reads as a
 * single-segment branch that does not exist.
 */
function encodeRef(branch: string): string {
	return branch.split('/').map(encodeURIComponent).join('/');
}

export function createPrWriter(client: GithubClient) {
	function base(target: RepoTarget): string {
		return `/repos/${target.owner}/${target.repo}`;
	}

	return {
		/** Head commit sha of `branch` on the base ref. */
		async getRef(target: RepoTarget, branch: string): Promise<string> {
			const response = await client.request<RefResponse>(
				`${base(target)}/git/ref/heads/${encodeRef(branch)}`
			);
			return response.body.object.sha;
		},

		/**
		 * Creates `refs/heads/<branch>` at `baseSha`.
		 *
		 * A 422 "Reference already exists" is the converged-retry path, NOT an
		 * error: the branch name is a deterministic function of the bump set,
		 * so an existing branch is *this* PR's branch from an attempt that died
		 * mid-flight. It is reused as-is rather than force-reset here — the
		 * subsequent `updateRef` moves it, and blindly resetting it first would
		 * discard a concurrent writer's commit before we know we can replace it.
		 */
		async ensureBranch(
			target: RepoTarget,
			branch: string,
			baseSha: string
		): Promise<{ created: boolean }> {
			try {
				await client.request(`${base(target)}/git/refs`, {
					method: 'POST',
					body: { ref: `refs/heads/${branch}`, sha: baseSha },
				});
				return { created: true };
			} catch (error) {
				if (is422With(error, 'already exists')) {
					return { created: false };
				}
				throw error;
			}
		},

		/** Tree sha of a commit — the `base_tree` every new tree builds on. */
		async getCommit(
			target: RepoTarget,
			sha: string
		): Promise<{ treeSha: string }> {
			const response = await client.request<CommitResponse>(
				`${base(target)}/git/commits/${sha}`
			);
			return { treeSha: response.body.tree.sha };
		},

		async createBlob(target: RepoTarget, content: string): Promise<string> {
			const response = await client.request<BlobResponse>(
				`${base(target)}/git/blobs`,
				{
					method: 'POST',
					body: { content, encoding: 'utf-8' },
				}
			);
			return response.body.sha;
		},

		async createTree(
			target: RepoTarget,
			baseTreeSha: string,
			files: readonly TreeFile[]
		): Promise<string> {
			const response = await client.request<TreeResponse>(
				`${base(target)}/git/trees`,
				{
					method: 'POST',
					body: {
						base_tree: baseTreeSha,
						tree: files.map((file) => ({
							path: file.path,
							mode: '100644',
							type: 'blob',
							sha: file.sha,
						})),
					},
				}
			);
			return response.body.sha;
		},

		async createCommit(
			target: RepoTarget,
			input: { message: string; treeSha: string; parentSha: string }
		): Promise<string> {
			const response = await client.request<CommitResponse>(
				`${base(target)}/git/commits`,
				{
					method: 'POST',
					body: {
						message: input.message,
						tree: input.treeSha,
						parents: [input.parentSha],
					},
				}
			);
			return response.body.sha;
		},

		/**
		 * `force: true` on purpose. The branch is namespaced `understory/…` and
		 * derived from the bump set, so it is ours by construction; a retry
		 * after a crash finds a stale branch pointing at an older base and must
		 * be able to move it. Without force, every such retry would 422 forever.
		 */
		async updateRef(
			target: RepoTarget,
			branch: string,
			commitSha: string
		): Promise<void> {
			await client.request(
				`${base(target)}/git/refs/heads/${encodeRef(branch)}`,
				{
					method: 'PATCH',
					body: { sha: commitSha, force: true },
				}
			);
		},

		/**
		 * Opens the PR, or finds the one that already exists for this head —
		 * the second half of the converged-retry story started by
		 * `ensureBranch`.
		 */
		async openPull(
			target: RepoTarget,
			input: {
				title: string;
				head: string;
				base: string;
				body: string;
			}
		): Promise<PullSummary> {
			try {
				const response = await client.request<PullResponse>(
					`${base(target)}/pulls`,
					{
						method: 'POST',
						body: {
							title: input.title,
							head: input.head,
							base: input.base,
							body: input.body,
						},
					}
				);
				return {
					number: response.body.number,
					url: response.body.html_url,
				};
			} catch (error) {
				if (!is422With(error, 'already exists')) throw error;
				const existing = await client.request<PullResponse[]>(
					`${base(target)}/pulls?head=${encodeURIComponent(
						`${target.owner}:${input.head}`
					)}&state=open`
				);
				const found = existing.body[0];
				if (found === undefined) throw error;
				return { number: found.number, url: found.html_url };
			}
		},

		/** Best-effort: a repo without those labels must not fail the PR. */
		async addLabels(
			target: RepoTarget,
			number: number,
			labels: readonly string[]
		): Promise<boolean> {
			if (labels.length === 0) return false;
			try {
				await client.request(
					`${base(target)}/issues/${number}/labels`,
					{ method: 'POST', body: { labels: [...labels] } }
				);
				return true;
			} catch {
				return false;
			}
		},

		async getPull(
			target: RepoTarget,
			number: number
		): Promise<PullState | null> {
			try {
				const response = await client.request<PullResponse>(
					`${base(target)}/pulls/${number}`
				);
				return {
					number: response.body.number,
					state: response.body.state,
					merged: response.body.merged === true,
					mergedAt: parseDate(response.body.merged_at),
					closedAt: parseDate(response.body.closed_at),
					url: response.body.html_url,
				};
			} catch (error) {
				// A deleted / transferred PR is a terminal answer, not a retry.
				if (error instanceof GithubHttpError && error.status === 404) {
					return null;
				}
				throw error;
			}
		},
	};
}

export type PrWriter = ReturnType<typeof createPrWriter>;
