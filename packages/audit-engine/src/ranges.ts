import semver from 'semver';
import type { RangeKind, UpdateKind } from './types';

const GIT_PREFIXES = [
	'git:',
	'git+ssh:',
	'git+http:',
	'git+https:',
	'git+file:',
	'github:',
	'gitlab:',
	'bitbucket:',
	'gist:',
];

const SHORTHAND_GIT = /^[\w.-]+\/[\w.-]+(#.*)?$/;

/**
 * Classify a declared dependency range. Only `semver` (and the trivially
 * resolvable `wildcard`) ranges may be fed into outdated / fix computations.
 */
export function classifyRange(range: string | undefined | null): RangeKind {
	const value = (range ?? '').trim();
	if (value === '') return 'wildcard';
	if (value === '*' || value === 'x' || value === 'X') return 'wildcard';
	if (value.startsWith('workspace:')) return 'workspace';
	if (value.startsWith('catalog:')) return 'catalog';
	if (value.startsWith('npm:')) return 'alias';
	if (value.startsWith('file:')) return 'file';
	if (value.startsWith('link:')) return 'link';
	if (value.startsWith('portal:')) return 'link';
	if (value.startsWith('patch:')) return 'unknown';
	for (const prefix of GIT_PREFIXES) {
		if (value.startsWith(prefix)) return 'git';
	}
	if (value.startsWith('http:') || value.startsWith('https:')) return 'url';
	if (semver.validRange(value, { loose: true }) !== null) return 'semver';
	if (SHORTHAND_GIT.test(value)) return 'git';
	// `latest`, `next`, `beta`, … are dist-tags.
	if (/^[a-zA-Z][\w.-]*$/.test(value)) return 'tag';
	return 'unknown';
}

/** True when the range can be evaluated by the `semver` package. */
export function isSemverRange(range: string | undefined | null): boolean {
	if (range === undefined || range === null) return false;
	return semver.validRange(range, { loose: true }) !== null;
}

/** Highest version in `versions` that satisfies `range`, or `undefined`. */
export function maxSatisfyingVersion(
	versions: readonly string[],
	range: string
): string | undefined {
	if (!isSemverRange(range)) return undefined;
	const match = semver.maxSatisfying(
		versions.filter((v) => semver.valid(v, { loose: true }) !== null),
		range,
		{ loose: true, includePrerelease: false }
	);
	return match ?? undefined;
}

/**
 * Classify the distance between two versions.
 *
 * Deliberately *not* `semver.diff`: we collapse the `pre*` results so that a
 * prerelease → release transition on the same tuple reads as `patch` rather
 * than the surprising `major` that `semver.diff` can return.
 */
export function updateKindBetween(from: string, to: string): UpdateKind {
	const a = semver.parse(from, { loose: true });
	const b = semver.parse(to, { loose: true });
	if (a === null || b === null) return 'none';
	if (semver.gte(a, b, { loose: true })) return 'none';
	if (a.major !== b.major) return 'major';
	if (a.minor !== b.minor) return 'minor';
	if (a.patch !== b.patch) return 'patch';
	// Same x.y.z but different prerelease/build metadata.
	return 'patch';
}

/** `true` when `version` satisfies `range`, tolerating garbage input. */
export function satisfiesRange(version: string, range: string): boolean {
	if (semver.valid(version, { loose: true }) === null) return false;
	if (!isSemverRange(range)) return false;
	return semver.satisfies(version, range, {
		loose: true,
		includePrerelease: true,
	});
}
