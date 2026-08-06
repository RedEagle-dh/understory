import type { ScanDiffFinding } from '../../../services/ports';
import type { NotificationMessage } from '../port';
import { vulnerabilitiesUrl } from './links';
import { groupBySeverity, maxSeverity } from './new-vulnerabilities';

export interface ResolvedVulnerabilitiesPayload {
	projectId: string;
	projectName: string;
	scanId: string;
	findings: readonly ScanDiffFinding[];
	baseUrl: string;
}

export function buildResolvedVulnerabilitiesMessage(
	payload: ResolvedVulnerabilitiesPayload
): NotificationMessage {
	const count = payload.findings.length;
	const severity = maxSeverity(
		payload.findings.map((finding) => finding.severity)
	);

	return {
		event: 'resolved_vulnerabilities',
		projectId: payload.projectId,
		projectName: payload.projectName,
		title: `${count} ${count === 1 ? 'vulnerability' : 'vulnerabilities'} resolved in ${payload.projectName}`,
		url: vulnerabilitiesUrl(payload.baseUrl, payload.projectId),
		...(severity === undefined ? {} : { severity }),
		summary: `${count} previously open ${count === 1 ? 'finding is' : 'findings are'} no longer present in the dependency tree.`,
		sections: groupBySeverity(payload.findings),
		footer: `Project ${payload.projectName} · scan ${payload.scanId}`,
	};
}
