import type { Severity } from '../types';

export const SEVERITIES: readonly Severity[] = [
	'low',
	'moderate',
	'high',
	'critical',
];

/** Ascending order; higher number = worse. */
export const SEVERITY_ORDER: Record<Severity, number> = {
	low: 0,
	moderate: 1,
	high: 2,
	critical: 3,
};

/** Negative when `a` is less severe than `b`. */
export function compareSeverity(a: Severity, b: Severity): number {
	return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

/** The worst severity in the list; `low` for an empty list. */
export function maxSeverity(severities: readonly Severity[]): Severity {
	let worst: Severity = 'low';
	for (const severity of severities) {
		if (compareSeverity(severity, worst) > 0) worst = severity;
	}
	return worst;
}

/**
 * Map a CVSS base score onto the npm/GitHub severity buckets.
 * 0–3.9 low · 4.0–6.9 moderate · 7.0–8.9 high · 9.0–10 critical
 */
export function cvssScoreToBucket(score: number): Severity {
	if (!Number.isFinite(score)) return 'low';
	if (score >= 9) return 'critical';
	if (score >= 7) return 'high';
	if (score >= 4) return 'moderate';
	return 'low';
}

const SEVERITY_ALIASES: Record<string, Severity> = {
	low: 'low',
	minor: 'low',
	info: 'low',
	informational: 'low',
	none: 'low',
	moderate: 'moderate',
	medium: 'moderate',
	warning: 'moderate',
	important: 'high',
	high: 'high',
	critical: 'critical',
};

/** Parse a textual severity label (`"HIGH"`, `"MEDIUM"`, …). */
export function parseSeverityLabel(
	label: string | undefined | null
): Severity | null {
	if (typeof label !== 'string') return null;
	return SEVERITY_ALIASES[label.trim().toLowerCase()] ?? null;
}

/* -------------------------------------------------------------------------- */
/* CVSS v3.x base score                                                       */
/* -------------------------------------------------------------------------- */

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

function roundUp(value: number): number {
	// CVSS v3.1 "Roundup", guarding against binary floating point noise.
	const scaled = Math.round(value * 100000);
	if (scaled % 10000 === 0) return scaled / 100000;
	return (Math.floor(scaled / 10000) + 1) / 10;
}

/**
 * Compute the CVSS v3.0/v3.1 base score from a vector string.
 * Returns `null` for vectors of another version or with missing metrics —
 * notably CVSS v4.0, whose scoring uses a lookup table we deliberately skip.
 */
export function cvssVectorBaseScore(
	vector: string | undefined | null
): number | null {
	if (typeof vector !== 'string') return null;
	const trimmed = vector.trim();
	if (!/^CVSS:3\.[01]\//i.test(trimmed)) return null;

	const metrics = new Map<string, string>();
	for (const part of trimmed.split('/')) {
		const [key, value] = part.split(':');
		if (key !== undefined && value !== undefined)
			metrics.set(key.toUpperCase(), value.toUpperCase());
	}

	const scopeChanged = metrics.get('S') === 'C';
	const av = AV[metrics.get('AV') ?? ''];
	const ac = AC[metrics.get('AC') ?? ''];
	const pr = (scopeChanged ? PR_CHANGED : PR_UNCHANGED)[
		metrics.get('PR') ?? ''
	];
	const ui = UI[metrics.get('UI') ?? ''];
	const c = CIA[metrics.get('C') ?? ''];
	const i = CIA[metrics.get('I') ?? ''];
	const a = CIA[metrics.get('A') ?? ''];
	if (
		av === undefined ||
		ac === undefined ||
		pr === undefined ||
		ui === undefined ||
		c === undefined ||
		i === undefined ||
		a === undefined
	) {
		return null;
	}

	const iss = 1 - (1 - c) * (1 - i) * (1 - a);
	const impact = scopeChanged
		? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
		: 6.42 * iss;
	if (impact <= 0) return 0;
	const exploitability = 8.22 * av * ac * pr * ui;
	const base = scopeChanged
		? Math.min(1.08 * (impact + exploitability), 10)
		: Math.min(impact + exploitability, 10);
	return roundUp(base);
}

/**
 * Best-effort severity bucket for a CVSS vector string. Returns `null` when the
 * vector cannot be scored (CVSS v4, malformed input) — callers should then fall
 * back to an explicit severity label.
 */
export function cvssVectorToBucket(
	vector: string | undefined | null
): Severity | null {
	const score = cvssVectorBaseScore(vector);
	return score === null ? null : cvssScoreToBucket(score);
}
