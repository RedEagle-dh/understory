import type { Severity } from '@workspace/audit-engine';
import type { ScanDiffFinding } from '../../../services/ports';
import type { NotificationMessage, NotificationSection } from '../port';
import { vulnerabilitiesUrl } from './links';

export interface NewVulnerabilitiesPayload {
	projectId: string;
	projectName: string;
	scanId: string;
	findings: readonly ScanDiffFinding[];
	baseUrl: string;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'moderate', 'low'];

export function maxSeverity(
	severities: readonly Severity[]
): Severity | undefined {
	return SEVERITY_ORDER.find((severity) => severities.includes(severity));
}

export function findingLineText(finding: ScanDiffFinding): string {
	const scope = finding.workspace === '' ? '' : ` (${finding.workspace})`;
	const fix =
		finding.fixedIn === null
			? 'no fix available'
			: `fix: ${finding.fixedIn}`;
	const direct = finding.isDirect ? 'direct' : 'transitive';
	return `${finding.packageName}@${finding.packageVersion}${scope} — ${finding.summary} [${direct}, ${fix}]`;
}

/** One section per severity bucket, highest first — the shape both providers render well. */
export function groupBySeverity(
	findings: readonly ScanDiffFinding[]
): NotificationSection[] {
	const sections: NotificationSection[] = [];
	for (const severity of SEVERITY_ORDER) {
		const bucket = findings.filter(
			(finding) => finding.severity === severity
		);
		if (bucket.length === 0) continue;
		sections.push({
			heading: `${severity.toUpperCase()} (${bucket.length})`,
			lines: bucket.map((finding) => ({
				text: findingLineText(finding),
				severity: finding.severity,
				...(finding.url === null ? {} : { url: finding.url }),
			})),
		});
	}
	return sections;
}

export function buildNewVulnerabilitiesMessage(
	payload: NewVulnerabilitiesPayload
): NotificationMessage {
	const count = payload.findings.length;
	const severity = maxSeverity(
		payload.findings.map((finding) => finding.severity)
	);
	const fixable = payload.findings.filter(
		(finding) => finding.fixedIn !== null
	).length;

	return {
		event: 'new_vulnerabilities',
		projectId: payload.projectId,
		projectName: payload.projectName,
		title: `${count} new ${count === 1 ? 'vulnerability' : 'vulnerabilities'} in ${payload.projectName}`,
		url: vulnerabilitiesUrl(payload.baseUrl, payload.projectId),
		...(severity === undefined ? {} : { severity }),
		summary: `${count} new ${count === 1 ? 'finding' : 'findings'} detected${
			severity === undefined ? '' : `, highest severity ${severity}`
		}. ${fixable} of ${count} have a fixed version available.`,
		sections: groupBySeverity(payload.findings),
		footer: `Project ${payload.projectName} · scan ${payload.scanId}`,
	};
}
