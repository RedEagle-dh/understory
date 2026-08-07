import type { LoggerPort } from '@declarativejs/core';
import semver from 'semver';

export interface UpdateStatus {
	readonly currentVersion: string;
	readonly latestVersion: string | null;
	readonly releaseUrl: string | null;
	readonly updateAvailable: boolean;
	readonly checkedAt: Date | null;
}

export interface UpdateCheckService {
	/** Fetches the latest release and updates the in-memory status. */
	check(): Promise<UpdateStatus>;
	/**
	 * Current status. If no check has run yet, one is kicked off in the
	 * background so the first UI request after boot converges without
	 * waiting for the cron cadence.
	 */
	status(): UpdateStatus;
}

interface Deps {
	fetchImpl: typeof fetch;
	/** Baked into the image at build time; 'dev' (or any non-semver) disables checking. */
	currentVersion: string;
	/** `owner/repo` whose GitHub releases are the update feed. */
	repo: string;
	/** GitHub API base URL — shared with the rest of the app for GHE/testing. */
	apiUrl: string;
	enabled: boolean;
	log: LoggerPort;
}

/** `v0.0.1` and `0.0.1` are the same version; GitHub tags carry the prefix. */
function normalize(version: string): string | null {
	return semver.valid(version.replace(/^v/, ''));
}

/**
 * Polls the GitHub releases feed for a newer version than the one baked into
 * this image. Purely informational and in-memory: nothing is persisted, and
 * every failure degrades to "no update known" rather than an error surface —
 * air-gapped installs run with UPDATE_CHECK=false and never see a request.
 */
export function createUpdateCheckService(deps: Deps): UpdateCheckService {
	const current = normalize(deps.currentVersion);
	const active = deps.enabled && current !== null;

	let latestVersion: string | null = null;
	let releaseUrl: string | null = null;
	let checkedAt: Date | null = null;
	let inFlight: Promise<UpdateStatus> | null = null;

	function snapshot(): UpdateStatus {
		return {
			currentVersion: deps.currentVersion,
			latestVersion,
			releaseUrl,
			updateAvailable:
				current !== null &&
				latestVersion !== null &&
				semver.gt(latestVersion, current),
			checkedAt,
		};
	}

	async function runCheck(): Promise<UpdateStatus> {
		try {
			const response = await deps.fetchImpl(
				`${deps.apiUrl}/repos/${deps.repo}/releases/latest`,
				{
					headers: {
						accept: 'application/vnd.github+json',
						'user-agent': 'understory-update-check',
					},
				}
			);
			// 404 = repo has no releases yet. Anything else non-ok is a
			// transient upstream problem; keep the previous answer.
			if (response.ok) {
				const body = (await response.json()) as {
					tag_name?: string;
					html_url?: string;
				};
				const tag = body.tag_name ?? '';
				latestVersion = normalize(tag);
				releaseUrl = body.html_url ?? null;
			} else if (response.status === 404) {
				latestVersion = null;
				releaseUrl = null;
			}
			checkedAt = new Date();
		} catch (error) {
			deps.log.debug('update check failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return snapshot();
	}

	return {
		async check() {
			if (!active) return snapshot();
			if (inFlight === null) {
				inFlight = runCheck().finally(() => {
					inFlight = null;
				});
			}
			return inFlight;
		},
		status() {
			if (active && checkedAt === null && inFlight === null) {
				inFlight = runCheck().finally(() => {
					inFlight = null;
				});
			}
			return snapshot();
		},
	};
}
