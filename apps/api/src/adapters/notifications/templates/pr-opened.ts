import type { Severity } from '@workspace/audit-engine';
import type { schema } from '@workspace/db';
import type { NotificationMessage } from '../port';
import { pullRequestsUrl } from './links';

/** One dependency bump carried by the PR — B8 fills this from `pull_request_bumps`. */
export interface PullRequestBumpSummary {
	packageName: string;
	workspace: string;
	fromVersion: string | null;
	toVersion: string;
	severity?: Severity;
	advisoryId?: string;
}

export interface PullRequestPayload {
	projectId: string;
	projectName: string;
	/** Our `pull_requests.id` — the dedupe identity for PR events. */
	pullRequestId: string;
	number: number;
	title: string;
	/** The GitHub PR URL. */
	url: string;
	branch: string;
	kind: schema.PullRequestKind;
	bumps: readonly PullRequestBumpSummary[];
	baseUrl: string;
}

export function bumpLines(
	bumps: readonly PullRequestBumpSummary[]
): { text: string; severity?: Severity }[] {
	return bumps.map((bump) => {
		const scope = bump.workspace === '' ? '' : ` (${bump.workspace})`;
		const from = bump.fromVersion === null ? '' : `${bump.fromVersion} → `;
		const advisory =
			bump.advisoryId === undefined ? '' : ` [${bump.advisoryId}]`;
		return {
			text: `${bump.packageName}${scope}: ${from}${bump.toVersion}${advisory}`,
			...(bump.severity === undefined ? {} : { severity: bump.severity }),
		};
	});
}

export function buildPrOpenedMessage(
	payload: PullRequestPayload
): NotificationMessage {
	const severity = payload.bumps.find(
		(bump) => bump.severity !== undefined
	)?.severity;

	return {
		event: 'pr_opened',
		projectId: payload.projectId,
		projectName: payload.projectName,
		title: `PR #${payload.number} opened for ${payload.projectName}: ${payload.title}`,
		url: payload.url,
		...(severity === undefined ? {} : { severity }),
		summary: `${payload.kind === 'auto_security' ? 'An automatic security' : 'A'} pull request with ${payload.bumps.length} dependency ${payload.bumps.length === 1 ? 'bump' : 'bumps'} was opened on branch ${payload.branch}.`,
		sections: [{ heading: 'Bumps', lines: bumpLines(payload.bumps) }],
		footer: `Project ${payload.projectName} · ${pullRequestsUrl(payload.baseUrl, payload.projectId)}`,
	};
}
