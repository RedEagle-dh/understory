import { t } from '@declarativejs/core';
import { Severity } from './common';

const NullableNumber = t.Union([t.Number(), t.Null()]);
const NullableString = t.Union([t.String(), t.Null()]);

export const ScanCountersView = t.Object({
	totalDeps: NullableNumber,
	directDeps: NullableNumber,
	peerDeps: NullableNumber,
	vulnCritical: NullableNumber,
	vulnHigh: NullableNumber,
	vulnModerate: NullableNumber,
	vulnLow: NullableNumber,
	outdatedCount: NullableNumber,
	majorOutdatedCount: NullableNumber,
	newFindings: NullableNumber,
	resolvedFindings: NullableNumber,
});

/** List row: the summary fields plus the counters the UI charts. */
export const ScanListItem = t.Composite([
	t.Object({
		id: t.String(),
		projectId: t.String(),
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
		commitSha: NullableString,
		branch: NullableString,
		depsReused: t.Boolean(),
		startedAt: t.Date(),
		finishedAt: t.Union([t.Date(), t.Null()]),
		durationMs: NullableNumber,
		errorCode: NullableString,
		/** Non-fatal degradations ("no lockfile found", registry hiccups, …). */
		warnings: t.Array(t.String(), { maxItems: 50 }),
	}),
	ScanCountersView,
]);

export const ScanDetail = t.Composite([
	ScanListItem,
	t.Object({
		dependencySetId: NullableString,
		lockHash: NullableString,
		errorMessage: NullableString,
		triggeredBy: NullableString,
	}),
]);

export const ScanDiffFindingView = t.Object({
	findingId: t.String(),
	advisoryId: t.String(),
	packageName: t.String(),
	packageVersion: t.String(),
	workspace: t.String(),
	severity: Severity,
	isDirect: t.Boolean(),
	fixedIn: NullableString,
	fixType: t.Union([
		t.Literal('patch'),
		t.Literal('minor'),
		t.Literal('major'),
		t.Literal('none'),
		t.Null(),
	]),
	summary: t.String(),
	url: NullableString,
});

export const ScanDiffMajorView = t.Object({
	packageName: t.String(),
	workspace: t.String(),
	currentVersion: t.String(),
	previousLatestVersion: NullableString,
	latestVersion: NullableString,
});

export const ScanDiffView = t.Object({
	newFindings: t.Array(ScanDiffFindingView, { maxItems: 500 }),
	resolvedFindings: t.Array(ScanDiffFindingView, { maxItems: 500 }),
	newMajors: t.Array(ScanDiffMajorView, { maxItems: 500 }),
});
