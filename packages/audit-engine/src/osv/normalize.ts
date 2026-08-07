import { normalizeGhsaId } from '../advisories/normalize-npm';
import {
	cvssScoreToBucket,
	cvssVectorBaseScore,
	parseSeverityLabel,
} from '../advisories/severity';
import { pep440Versioning } from '../pep440';
import type {
	AdvisoryRange,
	Ecosystem,
	NormalizedAdvisory,
	OsvAffected,
	OsvEvent,
	OsvRange,
	OsvVuln,
	Severity,
} from '../types';
import { semverVersioning, type Versioning } from '../versioning';

const GHSA_ID = /^GHSA-/i;
const CVE_ID = /^CVE-\d{4}-\d{4,}$/i;
const SUPPORTED_RANGE_TYPES = new Set(['SEMVER', 'ECOSYSTEM']);

/** OSV's `package.ecosystem` value per engine ecosystem. */
export const OSV_ECOSYSTEM_NAMES: Record<Ecosystem, string> = {
	npm: 'npm',
	pypi: 'PyPI',
};

interface EcosystemRenderConfig {
	osvName: string;
	versioning: Versioning;
	/** Render one half-open interval in the ecosystem's range syntax. */
	renderClause(interval: Interval): string;
	/** An exact-version entry of `affected[].versions` as a range. */
	renderExact(version: string): string;
	/**
	 * `true` when every interval of an affected entry collapses into ONE
	 * AdvisoryRange row (npm's `||` union); `false` emits one row per interval
	 * (PEP 440 specifier sets have no OR).
	 */
	unionRows: boolean;
}

const RENDERERS: Record<Ecosystem, EcosystemRenderConfig> = {
	npm: {
		osvName: 'npm',
		versioning: semverVersioning,
		renderClause(interval) {
			const parts = boundParts(interval);
			return parts.length > 0 ? parts.join(' ') : '*';
		},
		renderExact: (version) => version,
		unionRows: true,
	},
	pypi: {
		osvName: 'PyPI',
		versioning: pep440Versioning,
		renderClause(interval) {
			const parts = boundParts(interval);
			return parts.length > 0 ? parts.join(',') : '>=0';
		},
		renderExact: (version) => `==${version}`,
		unionRows: false,
	},
};

/** One half-open interval extracted from an OSV event list. */
export interface Interval {
	/** Lower bound (inclusive); `undefined` or `'0'` = from the beginning. */
	introduced?: string;
	/** Exclusive upper bound. */
	fixed?: string;
	/** Inclusive upper bound, only when no `fixed` exists. */
	lastAffected?: string;
}

function boundParts(interval: Interval): string[] {
	const parts: string[] = [];
	if (interval.introduced !== undefined && interval.introduced !== '0') {
		parts.push(`>=${interval.introduced}`);
	}
	if (interval.fixed !== undefined) {
		parts.push(`<${interval.fixed}`);
	} else if (interval.lastAffected !== undefined) {
		parts.push(`<=${interval.lastAffected}`);
	}
	return parts;
}

function normalizeId(id: string): string {
	return GHSA_ID.test(id)
		? normalizeGhsaId(id)
		: id.toUpperCase().startsWith('CVE-')
			? id.toUpperCase()
			: id;
}

/** Canonical id preference: GHSA > CVE > the OSV id itself. */
export function pickCanonicalId(ids: readonly string[]): string {
	const normalized = ids
		.filter((id) => typeof id === 'string' && id !== '')
		.map(normalizeId);
	const ghsa = normalized.find((id) => GHSA_ID.test(id));
	if (ghsa !== undefined) return ghsa;
	const cve = normalized.find((id) => CVE_ID.test(id));
	if (cve !== undefined) return cve;
	return normalized[0] ?? '';
}

function eventVersion(event: OsvEvent): string | undefined {
	return (
		event.introduced ?? event.fixed ?? event.last_affected ?? event.limit
	);
}

/**
 * Sort the events of a range so that `introduced`/`fixed` pairs line up even
 * when the database stores them out of order. Falls back to the original order
 * when any version is not comparable under `versioning` (`ECOSYSTEM` ranges
 * may not be).
 */
export function sortOsvEvents(
	events: readonly OsvEvent[],
	versioning: Versioning = semverVersioning
): OsvEvent[] {
	const comparable = events.every((event) => {
		const version = eventVersion(event);
		return (
			version === '0' ||
			(version !== undefined && versioning.isValidVersion(version))
		);
	});
	if (!comparable) return [...events];
	const weight = (event: OsvEvent) =>
		event.introduced !== undefined ? 0 : 1;
	return [...events]
		.map((event, index) => ({ event, index }))
		.sort((a, b) => {
			const va = eventVersion(a.event) ?? '0';
			const vb = eventVersion(b.event) ?? '0';
			if (va === '0' && vb !== '0') return -1;
			if (vb === '0' && va !== '0') return 1;
			const compared = va === vb ? 0 : versioning.compare(va, vb);
			if (compared !== 0) return compared;
			const byWeight = weight(a.event) - weight(b.event);
			return byWeight !== 0 ? byWeight : a.index - b.index;
		})
		.map(({ event }) => event);
}

/**
 * Turn one OSV `affected[].ranges[]` entry into half-open intervals.
 *
 * `introduced: "0"` is the sentinel for "from the beginning" and drops the
 * lower bound; a `last_affected` without a `fixed` produces an inclusive upper
 * bound.
 */
export function osvRangeToIntervals(
	range: OsvRange,
	versioning: Versioning = semverVersioning
): Interval[] {
	const type = (range.type ?? 'SEMVER').toUpperCase();
	if (!SUPPORTED_RANGE_TYPES.has(type)) return [];
	const events = sortOsvEvents(range.events ?? [], versioning);
	const intervals: Interval[] = [];
	let introduced: string | null = null;
	let open = false;

	const emit = (upper?: Pick<Interval, 'fixed' | 'lastAffected'>) => {
		intervals.push({
			introduced: introduced ?? undefined,
			...upper,
		});
		introduced = null;
		open = false;
	};

	for (const event of events) {
		if (event.introduced !== undefined) {
			if (open) emit();
			introduced = event.introduced;
			open = true;
			continue;
		}
		if (event.fixed !== undefined) {
			emit({ fixed: event.fixed });
			continue;
		}
		if (event.last_affected !== undefined) {
			emit({ lastAffected: event.last_affected });
		}
	}
	if (open) emit();

	return intervals;
}

/** {@link osvRangeToIntervals} rendered as npm semver range clauses. */
export function osvRangeToClauses(range: OsvRange): string[] {
	return osvRangeToIntervals(range).map((interval) =>
		RENDERERS.npm.renderClause(interval)
	);
}

function affectedToRanges(
	affected: OsvAffected,
	ecosystem: Ecosystem
): AdvisoryRange[] {
	const config = RENDERERS[ecosystem];
	const rawName = affected.package?.name;
	if (typeof rawName !== 'string' || rawName === '') return [];
	const affectedEcosystem = affected.package?.ecosystem ?? '';
	if (
		affectedEcosystem !== '' &&
		affectedEcosystem.toLowerCase() !== config.osvName.toLowerCase()
	) {
		return [];
	}
	const packageName = config.versioning.normalizeName(rawName);

	const clauses: string[] = [];
	for (const range of affected.ranges ?? []) {
		for (const interval of osvRangeToIntervals(range, config.versioning)) {
			clauses.push(config.renderClause(interval));
		}
	}
	if (
		clauses.length === 0 &&
		Array.isArray(affected.versions) &&
		affected.versions.length > 0
	) {
		clauses.push(
			...affected.versions.map((version) => config.renderExact(version))
		);
	}
	if (clauses.length === 0) return [];

	const fixed: string[] = [];
	for (const range of affected.ranges ?? []) {
		for (const event of range.events ?? []) {
			if (
				typeof event.fixed === 'string' &&
				config.versioning.isValidVersion(event.fixed)
			) {
				fixed.push(event.fixed);
			}
		}
	}
	const firstPatched =
		fixed.length > 0
			? fixed.sort((a, b) => config.versioning.compare(a, b))[0]
			: undefined;

	const unique = [...new Set(clauses)];
	if (config.unionRows) {
		return [
			{
				ecosystem,
				packageName,
				vulnerableRange: unique.join(' || '),
				firstPatched,
			},
		];
	}
	return unique.map((vulnerableRange) => ({
		ecosystem,
		packageName,
		vulnerableRange,
		firstPatched,
	}));
}

function extractSeverity(vuln: OsvVuln): {
	severity: Severity;
	cvssScore?: number;
	cvssVector?: string;
} {
	let cvssVector: string | undefined;
	let cvssScore: number | undefined;

	const candidates = [...(vuln.severity ?? [])];
	for (const affected of vuln.affected ?? [])
		candidates.push(...(affected.severity ?? []));

	// Prefer the highest-versioned CVSS vector we can actually score.
	for (const entry of candidates) {
		if (typeof entry.score !== 'string') continue;
		const score = cvssVectorBaseScore(entry.score);
		if (score !== null && (cvssScore === undefined || score > cvssScore)) {
			cvssScore = score;
			cvssVector = entry.score;
		} else if (cvssVector === undefined) {
			cvssVector = entry.score;
		}
	}

	const labelled =
		parseSeverityLabel(vuln.database_specific?.severity) ??
		parseSeverityLabel(
			(
				vuln.affected?.[0]?.database_specific as
					| { severity?: string }
					| undefined
			)?.severity
		);

	const severity: Severity =
		labelled ??
		(cvssScore === undefined ? 'moderate' : cvssScoreToBucket(cvssScore));

	return { severity, cvssScore, cvssVector };
}

function firstLine(text: string | undefined): string | undefined {
	if (typeof text !== 'string') return undefined;
	const line = text.split('\n').find((candidate) => candidate.trim() !== '');
	return line?.trim();
}

export interface NormalizeOsvOptions {
	/**
	 * Ecosystem whose `affected[]` entries to keep (an advisory can span
	 * several). Ranges are rendered in that ecosystem's own syntax. Default
	 * `npm`.
	 */
	ecosystem?: Ecosystem;
}

/** Convert an OSV vulnerability document into a {@link NormalizedAdvisory}. */
export function normalizeOsvVuln(
	vuln: OsvVuln,
	options: NormalizeOsvOptions = {}
): NormalizedAdvisory {
	const ecosystem = options.ecosystem ?? 'npm';
	const allIds = [vuln.id, ...(vuln.aliases ?? [])].filter(
		(id): id is string => typeof id === 'string' && id !== ''
	);
	const canonical = pickCanonicalId(allIds);
	const aliases = [...new Set(allIds.map(normalizeId))]
		.filter((id) => id !== canonical)
		.sort();

	const ranges: AdvisoryRange[] = [];
	for (const affected of vuln.affected ?? []) {
		ranges.push(...affectedToRanges(affected, ecosystem));
	}

	const { severity, cvssScore, cvssVector } = extractSeverity(vuln);

	const cweIds = (vuln.database_specific?.cwe_ids ?? []).filter(
		(id): id is string => typeof id === 'string'
	);

	const url = GHSA_ID.test(canonical)
		? `https://github.com/advisories/${canonical}`
		: `https://osv.dev/vulnerability/${vuln.id}`;

	return {
		id: canonical,
		aliases,
		source: 'osv',
		sourceId: vuln.id,
		sourceModifiedAt: vuln.modified,
		summary: vuln.summary ?? firstLine(vuln.details) ?? vuln.id,
		details: vuln.details,
		severity,
		cvssScore,
		cvssVector,
		cweIds,
		url,
		publishedAt: vuln.published,
		modifiedAt: vuln.modified,
		withdrawnAt: vuln.withdrawn,
		ranges,
		raw: vuln,
	};
}
