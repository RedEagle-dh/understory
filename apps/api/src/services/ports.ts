import type { FixType, Severity } from '@workspace/audit-engine';

/**
 * Outbound seams the scan service depends on but does not own. B7
 * (notifications) and B8 (auto-PR) replace the no-op implementations below;
 * until then the scan pipeline is complete but inert.
 */

export interface ScanDiffFinding {
	findingId: string;
	advisoryId: string;
	packageName: string;
	packageVersion: string;
	workspace: string;
	severity: Severity;
	isDirect: boolean;
	fixedIn: string | null;
	fixType: FixType | null;
	summary: string;
	url: string | null;
}

export interface ScanDiffMajor {
	packageName: string;
	workspace: string;
	currentVersion: string;
	previousLatestVersion: string | null;
	latestVersion: string | null;
}

export interface ScanDiffEvent {
	projectId: string;
	projectName: string;
	scanId: string;
	newFindings: ScanDiffFinding[];
	resolvedFindings: ScanDiffFinding[];
	newMajors: ScanDiffMajor[];
}

export interface ScanFailedEvent {
	projectId: string;
	projectName: string;
	scanId: string;
	errorCode: string;
	errorMessage: string;
	/** Failure streak *including* this one — B7 dedupes on it. */
	consecutiveFailures: number;
}

export interface AutoPrSelection {
	packageName: string;
	workspace: string;
	/** The version the fix requires; the PR service may pick a higher one. */
	toVersion: string;
	fixType: FixType;
	advisoryId: string;
	findingId: string;
	severity: Severity;
}

export interface AutoPrInput {
	projectId: string;
	scanId: string;
	selections: AutoPrSelection[];
}

/** A direct dependency eligible for an automatic version-bump PR. */
export interface AutoBumpSelection {
	packageName: string;
	workspace: string;
	/** The registry's `latest` at scan time. */
	toVersion: string;
	updateKind: Exclude<FixType, 'none'>;
}

export interface AutoBumpInput {
	projectId: string;
	scanId: string;
	selections: AutoBumpSelection[];
}

export interface ScanNotifierPort {
	scanDiff(diff: ScanDiffEvent): Promise<void>;
	scanFailed(event: ScanFailedEvent): Promise<void>;
}

export interface AutoPrPort {
	maybeCreate(input: AutoPrInput): Promise<void>;
	/** Auto-bump PRs for outdated (non-security) direct dependencies. */
	maybeCreateBumps(input: AutoBumpInput): Promise<void>;
}

export const noopNotifier: ScanNotifierPort = {
	async scanDiff() {
		/* replaced in B7 */
	},
	async scanFailed() {
		/* replaced in B7 */
	},
};

export const noopAutoPr: AutoPrPort = {
	async maybeCreate() {
		/* replaced in B8 */
	},
	async maybeCreateBumps() {
		/* replaced in B8 */
	},
};
