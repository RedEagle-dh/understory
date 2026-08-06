import { t } from '@declarativejs/core';
import { Severity, SeverityCounts } from './common';

/** Public view of a project — the token itself is never serialized. */
export const ProjectView = t.Object({
	id: t.String(),
	name: t.String(),
	owner: t.String(),
	repo: t.String(),
	/** '' = tracking the repository's default branch. */
	branch: t.String(),
	manifestPaths: t.Union([t.Array(t.String(), { maxItems: 100 }), t.Null()]),
	hasToken: t.Boolean(),
	tokenLast4: t.Union([t.String(), t.Null()]),
	scanIntervalMinutes: t.Number(),
	paused: t.Boolean(),
	consecutiveFailures: t.Number(),
	nextScanAt: t.Date(),
	autoPrEnabled: t.Boolean(),
	autoPrMinSeverity: Severity,
	autoPrMaxBump: t.Union([
		t.Literal('patch'),
		t.Literal('minor'),
		t.Literal('major'),
	]),
	autoBumpEnabled: t.Boolean(),
	autoBumpMaxKind: t.Union([
		t.Literal('patch'),
		t.Literal('minor'),
		t.Literal('major'),
	]),
	autoBumpMinReleaseAgeHours: t.Number(),
	prBaseBranch: t.Union([t.String(), t.Null()]),
	prLabels: t.Union([t.Array(t.String(), { maxItems: 20 }), t.Null()]),
	regenerateLockfile: t.Boolean(),
	notifyOnNewMajor: t.Boolean(),
	createdAt: t.Date(),
	updatedAt: t.Date(),
});

export const ScanSummary = t.Object({
	id: t.String(),
	status: t.Union([
		t.Literal('running'),
		t.Literal('ok'),
		t.Literal('failed'),
	]),
	trigger: t.Union([
		t.Literal('schedule'),
		t.Literal('manual'),
		t.Literal('auto'),
	]),
	startedAt: t.Date(),
	finishedAt: t.Union([t.Date(), t.Null()]),
	errorCode: t.Union([t.String(), t.Null()]),
});

/** List rollup: project + open-vuln counts + outdated + last scan. */
export const ProjectListItem = t.Object({
	id: t.String(),
	name: t.String(),
	owner: t.String(),
	repo: t.String(),
	branch: t.String(),
	paused: t.Boolean(),
	vulnCounts: SeverityCounts,
	outdatedCount: t.Number(),
	majorOutdatedCount: t.Number(),
	lastScan: t.Union([ScanSummary, t.Null()]),
});

export const OWNER_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$';
export const REPO_PATTERN = '^[A-Za-z0-9._-]{1,100}$';
