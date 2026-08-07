import type { DistTags, PackumentVersion, UpdateKind } from './types';
import { semverVersioning, type Versioning } from './versioning';

export interface OutdatedInput {
	/** The currently installed version. */
	current: string;
	/** The range declared in package.json, when the dependency is direct. */
	declaredRange?: string;
	/** `dist-tags` of the package (only `latest` is required). */
	distTags: DistTags | { latest?: string };
	/**
	 * All published versions. Accepts a packument `versions` map or a plain
	 * list. Required to compute `wanted` exactly.
	 */
	versions?:
		| Record<string, Pick<PackumentVersion, 'deprecated'> | undefined>
		| readonly string[];
	/** Ecosystem version semantics. Defaults to npm/semver. */
	versioning?: Versioning;
}

export interface OutdatedResult {
	current: string;
	latest?: string;
	/** Highest published version satisfying `declaredRange`. */
	wanted?: string;
	updateKind: UpdateKind;
	/** Deprecation message of the *installed* version, when known. */
	deprecated?: string;
	/** `true` when `latest` is newer than `current`. */
	outdated: boolean;
	/** `true` when the declared range is not evaluable (git url, workspace:, …). */
	rangeUnsupported: boolean;
}

function versionList(input: OutdatedInput['versions']): string[] {
	if (input === undefined) return [];
	if (Array.isArray(input)) return [...input];
	return Object.keys(input as Record<string, unknown>);
}

function deprecationOf(
	input: OutdatedInput['versions'],
	version: string
): string | undefined {
	if (input === undefined || Array.isArray(input)) return undefined;
	const entry = (
		input as Record<string, { deprecated?: string } | undefined>
	)[version];
	return typeof entry?.deprecated === 'string' ? entry.deprecated : undefined;
}

/**
 * Classify how far behind an installed version is.
 *
 * `latest` comes from `dist-tags`; `wanted` is the highest published version
 * still satisfying the declared range (falling back to `latest` when the range
 * already admits it and no version list was supplied).
 */
export function computeOutdated(input: OutdatedInput): OutdatedResult {
	const { current, declaredRange } = input;
	const versioning = input.versioning ?? semverVersioning;
	const latest =
		typeof input.distTags?.latest === 'string' &&
		input.distTags.latest !== ''
			? input.distTags.latest
			: undefined;

	const versions = versionList(input.versions);
	const rangeUnsupported =
		declaredRange !== undefined && !versioning.isValidRange(declaredRange);

	let wanted: string | undefined;
	if (declaredRange !== undefined && !rangeUnsupported) {
		if (versions.length > 0) {
			wanted = versioning.maxSatisfying(versions, declaredRange);
		} else if (
			latest !== undefined &&
			versioning.satisfies(latest, declaredRange)
		) {
			wanted = latest;
		}
	} else if (declaredRange === undefined && latest !== undefined) {
		wanted = latest;
	}

	const currentValid = versioning.isValidVersion(current);
	const updateKind: UpdateKind =
		latest === undefined || !currentValid
			? 'none'
			: versioning.updateKindBetween(current, latest);

	return {
		current,
		latest,
		wanted,
		updateKind,
		deprecated: deprecationOf(input.versions, current),
		outdated: updateKind !== 'none',
		rangeUnsupported,
	};
}
