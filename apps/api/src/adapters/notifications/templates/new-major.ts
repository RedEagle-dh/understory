import type { ScanDiffMajor } from '../../../services/ports';
import type { NotificationMessage } from '../port';
import { dependenciesUrl } from './links';

export interface NewMajorPayload {
	projectId: string;
	projectName: string;
	scanId: string;
	majors: readonly ScanDiffMajor[];
	baseUrl: string;
}

export function buildNewMajorMessage(
	payload: NewMajorPayload
): NotificationMessage {
	const count = payload.majors.length;

	return {
		event: 'new_major',
		projectId: payload.projectId,
		projectName: payload.projectName,
		title: `${count} new major ${count === 1 ? 'release' : 'releases'} for ${payload.projectName}`,
		url: dependenciesUrl(payload.baseUrl, payload.projectId),
		summary: `${count} ${count === 1 ? 'dependency has' : 'dependencies have'} a new major version available since the last scan.`,
		sections: [
			{
				heading: 'Major updates',
				lines: payload.majors.map((major) => {
					const scope =
						major.workspace === '' ? '' : ` (${major.workspace})`;
					const previous =
						major.previousLatestVersion === null
							? ''
							: ` — previously latest was ${major.previousLatestVersion}`;
					return {
						text: `${major.packageName}${scope}: ${major.currentVersion} → ${major.latestVersion ?? 'unknown'}${previous}`,
					};
				}),
			},
		],
		footer: `Project ${payload.projectName} · scan ${payload.scanId}`,
	};
}
