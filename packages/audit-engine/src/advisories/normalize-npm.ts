import semver from 'semver';
import { isSemverRange } from '../ranges';
import type {
	NormalizedAdvisory,
	NpmBulkAdvisory,
	NpmBulkAdvisoryResponse,
	Severity,
} from '../types';
import { cvssScoreToBucket, parseSeverityLabel } from './severity';

const GHSA_PATTERN =
	/GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}/i;
const CVE_PATTERN = /^CVE-\d{4}-\d{4,}$/i;
const CWE_PATTERN = /^CWE-\d+$/i;

/** Canonical GHSA casing: uppercase prefix, lowercase base32 suffix. */
export function normalizeGhsaId(id: string): string {
	return `GHSA-${id.slice(5).toLowerCase()}`;
}

/** Pull the canonical `GHSA-…` id out of an advisory URL. */
export function extractGhsaId(url: string | undefined): string | undefined {
	if (typeof url !== 'string') return undefined;
	const match = GHSA_PATTERN.exec(url);
	return match === null ? undefined : normalizeGhsaId(match[0]);
}

/**
 * npm's bulk endpoint returns no `firstPatched`, but the vulnerable range
 * almost always carries an exclusive upper bound (`<4.17.21`). Take the highest
 * such bound as the first patched version.
 */
export function inferFirstPatched(
	range: string | undefined
): string | undefined {
	if (range === undefined || !isSemverRange(range)) return undefined;
	let parsed: semver.Range;
	try {
		parsed = new semver.Range(range, { loose: true });
	} catch {
		return undefined;
	}
	const bounds: string[] = [];
	for (const set of parsed.set) {
		for (const comparator of set) {
			if (comparator.operator !== '<') continue;
			const version = comparator.semver.version;
			if (typeof version === 'string' && semver.valid(version) !== null) {
				bounds.push(version);
			}
		}
	}
	if (bounds.length === 0) return undefined;
	return semver.sort(bounds).pop();
}

/** Normalize one entry of the npm bulk advisory response. */
export function normalizeNpmAdvisory(
	packageName: string,
	entry: NpmBulkAdvisory
): NormalizedAdvisory {
	const ghsa = extractGhsaId(entry.url);
	const cweIds: string[] = [];
	const cves: string[] = [];

	// npm puts CWE ids in `cwe`, but some advisories mix CVE ids in there too,
	// and a separate `cves` array shows up on newer payloads.
	for (const value of [...(entry.cwe ?? []), ...(entry.cves ?? [])]) {
		if (typeof value !== 'string') continue;
		if (CWE_PATTERN.test(value)) {
			if (!cweIds.includes(value.toUpperCase()))
				cweIds.push(value.toUpperCase());
		} else if (CVE_PATTERN.test(value)) {
			if (!cves.includes(value.toUpperCase()))
				cves.push(value.toUpperCase());
		}
	}

	const sourceId = String(entry.id);
	const canonical = ghsa ?? cves[0] ?? `npm:${sourceId}`;

	const aliases = new Set<string>([`npm:${sourceId}`, ...cves]);
	if (ghsa !== undefined) aliases.add(ghsa);
	aliases.delete(canonical);

	const cvssScore =
		typeof entry.cvss?.score === 'number' ? entry.cvss.score : undefined;
	const severity: Severity =
		parseSeverityLabel(entry.severity) ??
		(cvssScore === undefined ? 'moderate' : cvssScoreToBucket(cvssScore));

	const vulnerableRange = entry.vulnerable_versions ?? '*';

	return {
		id: canonical,
		aliases: [...aliases].sort(),
		source: 'npm',
		sourceId,
		summary: entry.title ?? canonical,
		severity,
		cvssScore,
		cvssVector:
			typeof entry.cvss?.vectorString === 'string'
				? entry.cvss.vectorString
				: undefined,
		cweIds,
		url: entry.url,
		ranges: [
			{
				ecosystem: 'npm',
				packageName,
				vulnerableRange,
				firstPatched: inferFirstPatched(vulnerableRange),
			},
		],
		raw: entry,
	};
}

/** Normalize a whole `{ "<pkg>": [advisory, …] }` bulk response. */
export function normalizeNpmBulkResponse(
	response: NpmBulkAdvisoryResponse
): NormalizedAdvisory[] {
	const out: NormalizedAdvisory[] = [];
	for (const [packageName, advisories] of Object.entries(response ?? {})) {
		if (!Array.isArray(advisories)) continue;
		for (const advisory of advisories) {
			if (advisory === null || typeof advisory !== 'object') continue;
			out.push(normalizeNpmAdvisory(packageName, advisory));
		}
	}
	return out;
}
