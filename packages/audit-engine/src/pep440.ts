import {
	explain,
	parse,
	compare as pepCompare,
	valid,
	validRange,
} from '@renovatebot/pep440';
import type { RangeKind } from './types';
import type { Versioning } from './versioning';

/**
 * PEP 503 name folding: PyPI treats `Django`, `django` and `zope.interface` /
 * `zope_interface` as the same project. Every advisory match and registry
 * lookup must go through this.
 */
export function normalizePypiName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[-_.]+/g, '-');
}

const CLAUSE = /^(===|==|!=|<=|>=|<|>|~=)\s*(.+?)\s*$/;

const GIT_PREFIXES = ['git+', 'git:'];

/**
 * `true` when `version`'s (epoch, release) tuple starts with `prefix`
 * (`"1.4"` matches `1.4`, `1.4.2`, `1.4rc1`; `"1!2"` requires epoch 1).
 * Implements `==X.Y.*` wildcard and `~=` compatible-release prefixes.
 */
function hasReleasePrefix(version: string, prefix: string): boolean {
	const parsed = parse(version);
	if (parsed === null) return false;
	let epoch = 0;
	let release = prefix;
	const bang = prefix.indexOf('!');
	if (bang !== -1) {
		epoch = Number(prefix.slice(0, bang));
		release = prefix.slice(bang + 1);
	}
	if (parsed.epoch !== epoch) return false;
	const parts = release.split('.').map(Number);
	if (parts.length === 0 || parts.some(Number.isNaN)) return false;
	return parts.every((part, i) => (parsed.release[i] ?? 0) === part);
}

/**
 * Evaluate one specifier clause with ORDERING semantics (PEP 440 comparison,
 * not pip's specifier rules): `<1.2.0` includes `1.2.0rc1`. Advisory ranges
 * are half-open intervals under version ordering (that is how OSV defines
 * `introduced`/`fixed` events), so pip's pre-release carve-outs would create
 * false negatives for installed pre-releases.
 */
function matchesClause(version: string, op: string, operand: string): boolean {
	if (op === '===') return version.trim() === operand;

	if (operand.endsWith('.*') && (op === '==' || op === '!=')) {
		const hit = hasReleasePrefix(version, operand.slice(0, -2));
		return op === '==' ? hit : !hit;
	}

	if (valid(operand) === null) return false;

	if (op === '~=') {
		const parsed = parse(operand);
		if (parsed === null || parsed.release.length < 2) return false;
		if (pepCompare(version, operand) < 0) return false;
		const releasePrefix = parsed.release.slice(0, -1).join('.');
		const prefix =
			parsed.epoch > 0
				? `${parsed.epoch}!${releasePrefix}`
				: releasePrefix;
		return hasReleasePrefix(version, prefix);
	}

	const cmp = pepCompare(version, operand);
	switch (op) {
		case '==':
			return cmp === 0;
		case '!=':
			return cmp !== 0;
		case '<':
			return cmp < 0;
		case '<=':
			return cmp <= 0;
		case '>':
			return cmp > 0;
		case '>=':
			return cmp >= 0;
		default:
			return false;
	}
}

function satisfiesSpecifier(version: string, range: string): boolean {
	if (valid(version) === null) return false;
	const clauses = range
		.split(',')
		.map((clause) => clause.trim())
		.filter((clause) => clause !== '');
	// An empty specifier set means "any version".
	return clauses.every((clause) => {
		const match = CLAUSE.exec(clause);
		if (match === null) return false;
		return matchesClause(version, match[1] as string, match[2] as string);
	});
}

function isPre(version: string): boolean {
	return explain(version)?.is_prerelease === true;
}

/** PyPI / PEP 440 semantics. */
export const pep440Versioning: Versioning = {
	isValidVersion(version) {
		return valid(version) !== null;
	},
	isValidRange(range) {
		if (range === undefined || range === null) return false;
		return validRange(range);
	},
	classifyRange(range) {
		const value = (range ?? '').trim();
		if (value === '' || value === '*') return 'wildcard';
		if (value.startsWith('file:')) return 'file';
		for (const prefix of GIT_PREFIXES) {
			if (value.startsWith(prefix)) return 'git';
		}
		if (value.includes('://')) return 'url';
		return (validRange(value) ? 'semver' : 'unknown') as RangeKind;
	},
	compare(a, b) {
		return pepCompare(a, b);
	},
	satisfies(version, range) {
		return satisfiesSpecifier(version, range);
	},
	maxSatisfying(versions, range) {
		const candidates = versions.filter(
			(version) =>
				valid(version) !== null &&
				!isPre(version) &&
				satisfiesSpecifier(version, range)
		);
		if (candidates.length === 0) return undefined;
		return candidates.sort(pepCompare).at(-1);
	},
	updateKindBetween(from, to) {
		const a = parse(from);
		const b = parse(to);
		if (a === null || b === null) return 'none';
		if (pepCompare(from, to) >= 0) return 'none';
		if (a.epoch !== b.epoch) return 'major';
		if ((a.release[0] ?? 0) !== (b.release[0] ?? 0)) return 'major';
		if ((a.release[1] ?? 0) !== (b.release[1] ?? 0)) return 'minor';
		return 'patch';
	},
	isPrerelease(version) {
		return isPre(version);
	},
	normalizeName(name) {
		return normalizePypiName(name);
	},
};
