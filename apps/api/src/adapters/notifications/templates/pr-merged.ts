import type { NotificationMessage } from '../port';
import { pullRequestsUrl } from './links';
import { bumpLines, type PullRequestPayload } from './pr-opened';

export function buildPrMergedMessage(
	payload: PullRequestPayload
): NotificationMessage {
	return {
		event: 'pr_merged',
		projectId: payload.projectId,
		projectName: payload.projectName,
		title: `PR #${payload.number} merged for ${payload.projectName}: ${payload.title}`,
		url: payload.url,
		summary: `${payload.bumps.length} dependency ${payload.bumps.length === 1 ? 'bump has' : 'bumps have'} landed on ${payload.projectName}.`,
		sections: [{ heading: 'Bumps', lines: bumpLines(payload.bumps) }],
		footer: `Project ${payload.projectName} · ${pullRequestsUrl(payload.baseUrl, payload.projectId)}`,
	};
}
