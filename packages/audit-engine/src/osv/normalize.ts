import semver from 'semver';
import { normalizeGhsaId } from '../advisories/normalize-npm';
import {
	cvssScoreToBucket,
	cvssVectorBaseScore,
	parseSeverityLabel,
} from '../advisories/severity';
import type {
	AdvisoryRange,
	NormalizedAdvisory,
	OsvAffected,
	OsvEvent,
	OsvRange,
	OsvVuln,
	Severity,
} from '../types';

const GHSA_ID = /^GHSA-/i;
const CVE_ID = /^CVE-\d{4}-\d{4,}$/i;
const SUPPORTED_RANGE_TYPES = new Set(['SEMVER', 'ECOSYSTEM']);

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
 * when any version is not semver-comparable (`ECOSYSTEM` ranges may not be).
 */
export function sortOsvEvents(events: readonly OsvEvent[]): OsvEvent[] {
	const comparable = events.every((event) => {
		const version = eventVersion(event);
		return (
			version === '0' ||
			(version !== undefined &&
				semver.valid(version, { loose: true }) !== null)
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
			const compared =
				va === vb ? 0 : semver.compare(va, vb, { loose: true });
			if (compared !== 0) return compared;
			const byWeight = weight(a.event) - weight(b.event);
			return byWeight !== 0 ? byWeight : a.index - b.index;
		})
		.map(({ event }) => event);
}

/**
 * Turn one OSV `affected[].ranges[]` entry into semver range clauses.
 *
 * `introduced: "0"` is the sentinel for "from the beginning" and drops the
 * lower bound; a `last_affected` without a `fixed` produces an inclusive upper
 * bound.
 */
export function osvRangeToClauses(range: OsvRange): string[] {
	const type = (range.type ?? 'SEMVER').toUpperCase();
	if (!SUPPORTED_RANGE_TYPES.has(type)) return [];
	const events = sortOsvEvents(range.events ?? []);
	const clauses: string[] = [];
	let introduced: string | null = null;
	let open = false;

	const emit = (upper?: string) => {
		const lower =
			introduced !== null && introduced !== '0' ? `>=${introduced}` : '';
		const clause = [lower, upper]
			.filter((part) => part !== undefined && part !== '')
			.join(' ');
		clauses.push(clause === '' ? '*' : clause);
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
			emit(`<${event.fixed}`);
			continue;
		}
		if (event.last_affected !== undefined) {
			emit(`<=${event.last_affected}`);
		}
	}
	if (open) emit();

	return clauses;
}

function affectedToRange(affected: OsvAffected): AdvisoryRange | null {
	const packageName = affected.package?.name;
	if (typeof packageName !== 'string' || packageName === '') return null;
	const ecosystem = affected.package?.ecosystem ?? '';
	if (ecosystem !== '' && !/^npm$/i.test(ecosystem)) return null;

	const clauses: string[] = [];
	for (const range of affected.ranges ?? []) {
		clauses.push(...osvRangeToClauses(range));
	}
	if (
		clauses.length === 0 &&
		Array.isArray(affected.versions) &&
		affected.versions.length > 0
	) {
		clauses.push(...affected.versions);
	}
	if (clauses.length === 0) return null;

	const fixed: string[] = [];
	for (const range of affected.ranges ?? []) {
		for (const event of range.events ?? []) {
			if (
				typeof event.fixed === 'string' &&
				semver.valid(event.fixed, { loose: true })
			) {
				fixed.push(event.fixed);
			}
		}
	}

	return {
		packageName,
		vulnerableRange: [...new Set(clauses)].join(' || '),
		firstPatched:
			fixed.length > 0 ? (semver.sort(fixed)[0] as string) : undefined,
	};
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

/** Convert an OSV vulnerability document into a {@link NormalizedAdvisory}. */
export function normalizeOsvVuln(vuln: OsvVuln): NormalizedAdvisory {
	const allIds = [vuln.id, ...(vuln.aliases ?? [])].filter(
		(id): id is string => typeof id === 'string' && id !== ''
	);
	const canonical = pickCanonicalId(allIds);
	const aliases = [...new Set(allIds.map(normalizeId))]
		.filter((id) => id !== canonical)
		.sort();

	const ranges: AdvisoryRange[] = [];
	for (const affected of vuln.affected ?? []) {
		const range = affectedToRange(affected);
		if (range !== null) ranges.push(range);
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
