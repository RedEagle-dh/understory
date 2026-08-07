import semver from 'semver';
import {
	classifyRange,
	isSemverRange,
	maxSatisfyingVersion,
	satisfiesRange,
	updateKindBetween,
} from './ranges';
import type { RangeKind, UpdateKind } from './types';

/**
 * Ecosystem-specific version and range semantics.
 *
 * Everything in the engine that compares, matches, or classifies versions goes
 * through this interface, so adding an ecosystem (PEP 440 for PyPI, …) means
 * implementing it once instead of touching every computation.
 */
export interface Versioning {
	/** `true` when `version` parses as a concrete version. */
	isValidVersion(version: string): boolean;
	/** `true` when `range` can be evaluated by this ecosystem's matcher. */
	isValidRange(range: string | undefined | null): boolean;
	/** Classify a declared range (exact/semver/tag/git/…). */
	classifyRange(range: string | undefined | null): RangeKind;
	/**
	 * Standard comparator contract. Both inputs must satisfy
	 * {@link isValidVersion}; behaviour on invalid input is unspecified.
	 */
	compare(a: string, b: string): number;
	/**
	 * Vulnerability-matching semantics: prerelease versions ARE candidates, so
	 * an installed prerelease is never accidentally considered safe.
	 */
	satisfies(version: string, range: string): boolean;
	/**
	 * Upgrade-target semantics: highest version satisfying `range`, prereleases
	 * excluded. `undefined` when nothing matches or the range is not evaluable.
	 */
	maxSatisfying(
		versions: readonly string[],
		range: string
	): string | undefined;
	/** Classify the distance between two versions. `none` when `to <= from`. */
	updateKindBetween(from: string, to: string): UpdateKind;
	/** `true` when `version` is a prerelease (dev/rc/beta/…). */
	isPrerelease(version: string): boolean;
	/**
	 * Canonical registry form of a package name (PEP 503 folding for PyPI;
	 * identity for npm). Apply before advisory matching and registry lookups.
	 */
	normalizeName(name: string): string;
}

/** npm semantics, delegating to the existing `ranges.ts` helpers. */
export const semverVersioning: Versioning = {
	isValidVersion(version) {
		return semver.valid(version, { loose: true }) !== null;
	},
	isValidRange(range) {
		return isSemverRange(range);
	},
	classifyRange(range) {
		return classifyRange(range);
	},
	compare(a, b) {
		return semver.compare(a, b, { loose: true });
	},
	satisfies(version, range) {
		return satisfiesRange(version, range);
	},
	maxSatisfying(versions, range) {
		return maxSatisfyingVersion(versions, range);
	},
	updateKindBetween(from, to) {
		return updateKindBetween(from, to);
	},
	isPrerelease(version) {
		return (semver.prerelease(version, { loose: true }) ?? []).length > 0;
	},
	normalizeName(name) {
		return name;
	},
};
