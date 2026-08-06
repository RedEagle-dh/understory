import { t } from '@declarativejs/core';
import { Severity } from './common';

const NullableString = t.Union([t.String(), t.Null()]);

export const DepType = t.Union([
	t.Literal('prod'),
	t.Literal('dev'),
	t.Literal('peer'),
	t.Literal('optional'),
	t.Literal('peer_optional'),
]);

export const UpdateKind = t.Union([
	t.Literal('none'),
	t.Literal('patch'),
	t.Literal('minor'),
	t.Literal('major'),
]);

export const DependencyListItem = t.Object({
	name: t.String(),
	version: t.String(),
	workspace: t.String(),
	depType: DepType,
	isDirect: t.Boolean(),
	depth: t.Number(),
	declaredRange: NullableString,
	currentVersion: t.String(),
	wantedVersion: NullableString,
	latestVersion: NullableString,
	updateKind: UpdateKind,
	deprecated: t.Boolean(),
	maxSeverity: t.Union([Severity, t.Null()]),
	openFindings: t.Number(),
});

export const DependencyOccurrence = t.Object({
	version: t.String(),
	workspace: t.String(),
	depType: DepType,
	isDirect: t.Boolean(),
	depth: t.Number(),
	declaredRange: NullableString,
	resolved: NullableString,
	peerDeps: t.Union([
		t.Record(
			t.String(),
			t.Object({ range: t.String(), optional: t.Boolean() })
		),
		t.Null(),
	]),
});

export const DependencyStatusView = t.Object({
	workspace: t.String(),
	currentVersion: t.String(),
	declaredRange: NullableString,
	wantedVersion: NullableString,
	latestVersion: NullableString,
	updateKind: UpdateKind,
	deprecatedMessage: NullableString,
	previousLatestVersion: NullableString,
	latestChangedAt: t.Union([t.Date(), t.Null()]),
});

export const PeerIssueView = t.Object({
	id: t.String(),
	packageName: t.String(),
	requiredBy: t.String(),
	requiredByVersion: t.String(),
	requiredRange: t.String(),
	resolvedVersion: NullableString,
	kind: t.Union([t.Literal('missing'), t.Literal('invalid')]),
	optional: t.Boolean(),
	state: t.Union([t.Literal('open'), t.Literal('resolved')]),
});

/** Single-segment package names arrive URL-encoded (`%40scope%2Fpkg`). */
export const PACKAGE_NAME_PATTERN =
	'^(@[a-z0-9-~][\\w-.~]*\\/)?[a-z0-9-~][\\w-.~]*$';
