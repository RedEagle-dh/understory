import type { DependencyStatusStore } from '../stores/dependency-status';
import type { FindingsStore, FindingWithAdvisory } from '../stores/findings';
import type { ScanDiffEvent, ScanDiffFinding, ScanDiffMajor } from './ports';

export interface ScanDiffStores {
	findings: FindingsStore;
	dependencyStatus: DependencyStatusStore;
}

export function toDiffFinding(row: FindingWithAdvisory): ScanDiffFinding {
	return {
		findingId: row.finding.id,
		advisoryId: row.finding.advisoryId,
		packageName: row.finding.packageName,
		packageVersion: row.finding.packageVersion,
		workspace: row.finding.workspace,
		severity: row.finding.severity,
		isDirect: row.finding.isDirect,
		fixedIn: row.finding.fixedIn,
		fixType: row.finding.fixType,
		summary: row.advisorySummary,
		url: row.advisoryUrl,
	};
}

function toDiffMajor(row: {
	packageName: string;
	workspace: string;
	currentVersion: string;
	previousLatestVersion: string | null;
	latestVersion: string | null;
}): ScanDiffMajor {
	return {
		packageName: row.packageName,
		workspace: row.workspace,
		currentVersion: row.currentVersion,
		previousLatestVersion: row.previousLatestVersion,
		latestVersion: row.latestVersion,
	};
}

/**
 * Three indexed queries, no snapshot comparison:
 * `firstSeenScanId = N`, `resolvedScanId = N`, and the dependency-status rows
 * whose `latestChangedAt` equals this scan's start while sitting on a major.
 */
export async function buildScanDiff(
	stores: ScanDiffStores,
	project: { id: string; name: string },
	scanId: string,
	scanStartedAt: Date
): Promise<ScanDiffEvent> {
	const [newFindings, resolvedFindings, newMajors] = await Promise.all([
		stores.findings.newForScan(scanId),
		stores.findings.resolvedForScan(scanId),
		stores.dependencyStatus.newMajorsForScan(project.id, scanStartedAt),
	]);

	return {
		projectId: project.id,
		projectName: project.name,
		scanId,
		newFindings: newFindings.map(toDiffFinding),
		resolvedFindings: resolvedFindings.map(toDiffFinding),
		newMajors: newMajors.map(toDiffMajor),
	};
}

export function isEmptyDiff(diff: ScanDiffEvent): boolean {
	return (
		diff.newFindings.length === 0 &&
		diff.resolvedFindings.length === 0 &&
		diff.newMajors.length === 0
	);
}
