import { t } from '@declarativejs/core';
import { Severity } from './common';

/** TypeBox mirrors of `pull_requests` / `pull_request_bumps` and the PR plan. */

export const PullRequestState = t.Union([
	t.Literal('creating'),
	t.Literal('open'),
	t.Literal('merged'),
	t.Literal('closed'),
	t.Literal('failed'),
]);

export const PullRequestKind = t.Union([
	t.Literal('manual'),
	t.Literal('auto_security'),
	t.Literal('auto_update'),
]);

export const PullRequestBumpView = t.Object({
	packageName: t.String(),
	workspace: t.String(),
	fromRange: t.Union([t.String(), t.Null()]),
	fromVersion: t.Union([t.String(), t.Null()]),
	toVersion: t.String(),
	advisoryId: t.Union([t.String(), t.Null()]),
	findingId: t.Union([t.String(), t.Null()]),
});

export const PullRequestView = t.Object({
	id: t.String(),
	projectId: t.String(),
	number: t.Union([t.Number(), t.Null()]),
	url: t.Union([t.String(), t.Null()]),
	branch: t.String(),
	baseBranch: t.String(),
	kind: PullRequestKind,
	state: PullRequestState,
	title: t.String(),
	commitSha: t.Union([t.String(), t.Null()]),
	lockfileUpdated: t.Boolean(),
	createdByUserId: t.Union([t.String(), t.Null()]),
	createdAt: t.Date(),
	updatedAt: t.Date(),
	mergedAt: t.Union([t.Date(), t.Null()]),
	closedAt: t.Union([t.Date(), t.Null()]),
	lastSyncedAt: t.Union([t.Date(), t.Null()]),
	errorMessage: t.Union([t.String(), t.Null()]),
	bumps: t.Array(PullRequestBumpView, { maxItems: 500 }),
});

export const PrPlanItemStatus = t.Union([
	t.Literal('changesManifest'),
	t.Literal('lockfileOnly'),
	t.Literal('dropped'),
]);

export const UpdateKind = t.Union([
	t.Literal('none'),
	t.Literal('patch'),
	t.Literal('minor'),
	t.Literal('major'),
]);

export const PrPlanAdvisoryView = t.Object({
	advisoryId: t.String(),
	findingId: t.String(),
	severity: Severity,
	url: t.String(),
});

export const PrPlanItemView = t.Object({
	packageName: t.String(),
	workspace: t.String(),
	manifestPath: t.String(),
	status: PrPlanItemStatus,
	fromVersion: t.Union([t.String(), t.Null()]),
	fromRange: t.Union([t.String(), t.Null()]),
	toVersion: t.Union([t.String(), t.Null()]),
	newRange: t.Union([t.String(), t.Null()]),
	updateKind: UpdateKind,
	severity: t.Union([Severity, t.Null()]),
	advisories: t.Array(PrPlanAdvisoryView, { maxItems: 100 }),
	reason: t.Union([t.String(), t.Null()]),
	warnings: t.Array(t.String(), { maxItems: 20 }),
});

export const PrPlanView = t.Object({
	projectId: t.String(),
	projectName: t.String(),
	branchKind: t.Union([t.Literal('security'), t.Literal('update')]),
	branch: t.String(),
	baseBranch: t.String(),
	title: t.String(),
	body: t.String(),
	items: t.Array(PrPlanItemView, { maxItems: 200 }),
	includedCount: t.Number(),
	droppedCount: t.Number(),
	severityCounts: t.Object({
		critical: t.Number(),
		high: t.Number(),
		moderate: t.Number(),
		low: t.Number(),
	}),
	manifestPaths: t.Array(t.String(), { maxItems: 200 }),
	lockfileRegenPlanned: t.Boolean(),
	lockfileNote: t.Union([t.String(), t.Null()]),
	warnings: t.Array(t.String(), { maxItems: 200 }),
	alreadyOpenPr: t.Union([
		t.Object({
			id: t.String(),
			number: t.Union([t.Number(), t.Null()]),
			url: t.Union([t.String(), t.Null()]),
			branch: t.String(),
			state: PullRequestState,
		}),
		t.Null(),
	]),
});

export const PrSelectionInputView = t.Object({
	name: t.String({ minLength: 1, maxLength: 214 }),
	workspace: t.Optional(t.String({ maxLength: 255 })),
	toVersion: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
});

export const PrCreateResultView = t.Object({
	id: t.String(),
	number: t.Number(),
	url: t.String(),
	branch: t.String(),
	lockfileUpdated: t.Boolean(),
});
