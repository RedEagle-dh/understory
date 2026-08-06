import semver from 'semver';
import { isSemverRange, satisfiesRange, updateKindBetween } from './ranges';
import type { FixType } from './types';

export interface AvailableVersion {
	version: string;
	deprecated?: string;
}

export interface FixInput {
	currentVersion: string;
	/** Range declared in package.json, used for `fixWithinRange`. */
	declaredRange?: string;
	/** Every vulnerable range affecting this package (across all advisories). */
	allRangesForPackage: readonly string[];
	/** Published versions, typically from the packument. */
	availableVersions: readonly (AvailableVersion | string)[];
}

export interface FixResult {
	/** Minimal safe upgrade target, or `null` when none exists. */
	fixedIn: string | null;
	fixType: FixType;
	/** `true` when `fixedIn` already satisfies the declared range. */
	fixWithinRange: boolean;
	/** Ranges that could not be parsed and were therefore ignored. */
	ignoredRanges: string[];
}

function toAvailable(entry: AvailableVersion | string): AvailableVersion {
	return typeof entry === 'string' ? { version: entry } : entry;
}

/**
 * Find the minimal published, non-prerelease, non-deprecated version greater
 * than `currentVersion` that satisfies **none** of the vulnerable ranges.
 *
 * This replaces npm's `fixAvailable`, which the bulk advisory endpoint does not
 * return. Vulnerable ranges are matched with `includePrerelease: true` so that
 * a prerelease installed version is not accidentally considered safe.
 */
export function computeFix(input: FixInput): FixResult {
	const { currentVersion, declaredRange } = input;

	const ignoredRanges = input.allRangesForPackage.filter(
		(range) => !isSemverRange(range)
	);
	const ranges = input.allRangesForPackage.filter((range) =>
		isSemverRange(range)
	);

	const currentValid = semver.valid(currentVersion, { loose: true }) !== null;

	const candidates = input.availableVersions
		.map(toAvailable)
		.filter((entry) => {
			if (semver.valid(entry.version, { loose: true }) === null)
				return false;
			if (entry.deprecated !== undefined && entry.deprecated !== '')
				return false;
			if (
				(semver.prerelease(entry.version, { loose: true }) ?? [])
					.length > 0
			)
				return false;
			if (
				currentValid &&
				!semver.gt(entry.version, currentVersion, { loose: true })
			) {
				return false;
			}
			return true;
		})
		.sort((a, b) => semver.compare(a.version, b.version, { loose: true }));

	const safe = candidates.find(
		(candidate) =>
			!ranges.some((range) => satisfiesRange(candidate.version, range))
	);

	if (safe === undefined) {
		return {
			fixedIn: null,
			fixType: 'none',
			fixWithinRange: false,
			ignoredRanges,
		};
	}

	const fixType: FixType = currentValid
		? (updateKindBetween(currentVersion, safe.version) as FixType)
		: 'none';

	return {
		fixedIn: safe.version,
		fixType,
		fixWithinRange:
			declaredRange !== undefined &&
			satisfiesRange(safe.version, declaredRange),
		ignoredRanges,
	};
}
