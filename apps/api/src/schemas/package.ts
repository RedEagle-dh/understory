import { t } from '@declarativejs/core';
import { Severity } from './common';
import { DepType, UpdateKind } from './dependency';

const NullableString = t.Union([t.String(), t.Null()]);

export const Ecosystem = t.Union([t.Literal('npm'), t.Literal('pypi')]);

/** One package as seen across every tracked repository. */
export const PackageIndexItem = t.Object({
	name: t.String(),
	ecosystem: Ecosystem,
	projectCount: t.Number(),
	directProjectCount: t.Number(),
	versionCount: t.Number(),
	versions: t.Array(t.String(), { maxItems: 8 }),
	openFindings: t.Number(),
	affectedProjects: t.Number(),
	maxSeverity: t.Union([Severity, t.Null()]),
});

/** One (project, version) pair shipping a package. */
export const PackageUsageItem = t.Object({
	projectId: t.String(),
	projectName: t.String(),
	owner: t.String(),
	repo: t.String(),
	ecosystem: Ecosystem,
	version: t.String(),
	workspaces: t.Array(t.String()),
	depTypes: t.Array(DepType),
	isDirect: t.Boolean(),
	depth: t.Number(),
	declaredRange: NullableString,
	latestVersion: NullableString,
	updateKind: UpdateKind,
	openFindings: t.Number(),
	maxSeverity: t.Union([Severity, t.Null()]),
});
