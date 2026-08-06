import type { NotificationMessage } from '../port';
import { projectUrl, scanUrl } from './links';

export interface ScanFailedPayload {
	projectId: string;
	projectName: string;
	scanId: string;
	errorCode: string;
	errorMessage: string;
	/** The failure-streak length that triggered this notification (1, 3 or 10). */
	failureBucket: number;
	baseUrl: string;
}

export function buildScanFailedMessage(
	payload: ScanFailedPayload
): NotificationMessage {
	const streak =
		payload.failureBucket === 1
			? 'first failure'
			: `${payload.failureBucket} consecutive failures`;

	return {
		event: 'scan_failed',
		projectId: payload.projectId,
		projectName: payload.projectName,
		title: `Scan failed for ${payload.projectName} (${streak})`,
		url: projectUrl(payload.baseUrl, payload.projectId),
		severity: payload.failureBucket >= 3 ? 'high' : 'moderate',
		summary: `The scheduled scan of ${payload.projectName} failed with ${payload.errorCode}.`,
		sections: [
			{
				heading: 'Error',
				lines: [
					{ text: `Code: ${payload.errorCode}` },
					{ text: payload.errorMessage.slice(0, 500) },
					{
						text: `Scan ${payload.scanId}`,
						url: scanUrl(payload.baseUrl, payload.scanId),
					},
				],
			},
		],
		footer: `The next attempt is scheduled with exponential backoff. Project ${payload.projectName}.`,
	};
}
