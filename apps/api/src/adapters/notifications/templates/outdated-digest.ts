import type { UpdateKind } from '@workspace/audit-engine';
import type { NotificationMessage, NotificationSection } from '../port';
import { dependenciesUrl } from './links';

export interface OutdatedDigestItem {
	packageName: string;
	workspace: string;
	currentVersion: string;
	latestVersion: string | null;
	updateKind: UpdateKind;
	isDirect: boolean;
}

export interface OutdatedDigestPayload {
	projectId: string;
	projectName: string;
	/** `YYYY-MM-DD` — also the dedupe dimension, so one digest per day. */
	day: string;
	items: readonly OutdatedDigestItem[];
	/** Total outdated packages, which may exceed `items.length`. */
	total: number;
	baseUrl: string;
}

const KINDS: UpdateKind[] = ['major', 'minor', 'patch'];

export function buildOutdatedDigestMessage(
	payload: OutdatedDigestPayload
): NotificationMessage {
	const sections: NotificationSection[] = [];
	for (const kind of KINDS) {
		const bucket = payload.items.filter((item) => item.updateKind === kind);
		if (bucket.length === 0) continue;
		sections.push({
			heading: `${kind.toUpperCase()} (${bucket.length})`,
			lines: bucket.map((item) => {
				const scope =
					item.workspace === '' ? '' : ` (${item.workspace})`;
				const direct = item.isDirect ? 'direct' : 'transitive';
				return {
					text: `${item.packageName}${scope}: ${item.currentVersion} → ${item.latestVersion ?? 'unknown'} [${direct}]`,
				};
			}),
		});
	}

	const omitted = payload.total - payload.items.length;
	if (omitted > 0) {
		sections.push({
			heading: `+${omitted} more`,
			lines: [
				{
					text: `${omitted} further outdated package(s) not listed.`,
					url: dependenciesUrl(payload.baseUrl, payload.projectId),
				},
			],
		});
	}

	const majors = payload.items.filter(
		(item) => item.updateKind === 'major'
	).length;

	return {
		event: 'outdated_digest',
		projectId: payload.projectId,
		projectName: payload.projectName,
		title: `Outdated dependencies in ${payload.projectName} (${payload.day})`,
		url: dependenciesUrl(payload.baseUrl, payload.projectId),
		summary: `${payload.total} outdated ${payload.total === 1 ? 'package' : 'packages'}, ${majors} of them a major release behind.`,
		sections,
		footer: `Daily digest for ${payload.projectName} · ${payload.day}`,
	};
}
