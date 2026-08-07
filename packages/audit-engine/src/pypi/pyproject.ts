import { parse as parseToml } from 'smol-toml';
import { normalizePypiName, pep440Versioning } from '../pep440';
import type { RangeKind } from '../types';
import { parsePep508 } from './pep508';

/**
 * One dependency declaration extracted from a Python manifest
 * (`pyproject.toml` or `requirements.txt`).
 */
export interface DeclaredPypiDep {
	/** PEP 503-normalized name. */
	name: string;
	/** As written: a PEP 508 string, or a poetry short form / inline table. */
	rawRange: string;
	/** Evaluable PEP 440 specifier set; `''` means "any version". */
	specifier: string;
	depType: 'prod' | 'dev' | 'optional';
	/**
	 * `semver` when {@link specifier} is evaluable, `wildcard` for `''`,
	 * `git`/`url`/`file` for direct references, `unknown` otherwise.
	 */
	rangeKind: RangeKind;
}

export interface PyprojectResult {
	/** Project name from `[project]` or `[tool.poetry]`. */
	name?: string;
	declared: DeclaredPypiDep[];
	usesPoetry: boolean;
	warnings: string[];
}

type PypiDepType = DeclaredPypiDep['depType'];

/** Prod beats dev beats optional when the same name is declared twice. */
const DEP_TYPE_PRECEDENCE: Record<PypiDepType, number> = {
	prod: 0,
	dev: 1,
	optional: 2,
};

/**
 * One declaration per normalized name, resolved by precedence
 * prod > dev > optional (first declaration wins within a type). This is the
 * lookup the lockfile parsers use to attribute direct dependencies.
 */
export function declaredByName(
	declared: readonly DeclaredPypiDep[]
): Map<string, DeclaredPypiDep> {
	const map = new Map<string, DeclaredPypiDep>();
	for (const dep of declared) {
		const existing = map.get(dep.name);
		if (
			existing === undefined ||
			DEP_TYPE_PRECEDENCE[dep.depType] <
				DEP_TYPE_PRECEDENCE[existing.depType]
		) {
			map.set(dep.name, dep);
		}
	}
	return map;
}

/* -------------------------------------------------------------------------- */
/* TOML shape guards                                                          */
/* -------------------------------------------------------------------------- */

function record(value: unknown): Record<string, unknown> | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		value instanceof Date
	) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === 'string');
}

/* -------------------------------------------------------------------------- */
/* Poetry range translation                                                   */
/* -------------------------------------------------------------------------- */

/** Leading dotted-numeric release of a poetry version, e.g. `1.2.3` of `^1.2.3`. */
function numericParts(version: string): number[] | null {
	const match = /^v?(\d+(?:\.\d+)*)/.exec(version.trim());
	if (match === null) return null;
	return (match[1] as string).split('.').map(Number);
}

/**
 * Caret upper bound: bump the leftmost non-zero component (`^1.2.3` → `2`,
 * `^0.2.3` → `0.3`, `^0.0.3` → `0.0.4`), matching poetry's semver-style caret.
 */
function caretUpperBound(parts: number[]): string {
	let index = parts.findIndex((part) => part !== 0);
	if (index === -1) index = parts.length - 1;
	const bumped = parts.slice(0, index + 1);
	bumped[index] = (bumped[index] as number) + 1;
	return bumped.join('.');
}

/** Tilde upper bound: `~1.2.3` / `~1.2` → `1.3`; a bare `~1` allows `<2`. */
function tildeUpperBound(parts: number[]): string {
	if (parts.length === 1) return String((parts[0] as number) + 1);
	return `${parts[0]}.${(parts[1] as number) + 1}`;
}

interface TranslatedRange {
	specifier: string;
	rangeKind: RangeKind;
}

/**
 * Translate a poetry version constraint into a PEP 440 specifier set.
 *
 * Poetry's caret/tilde shorthands are not PEP 440, so they are rewritten into
 * `>=lower,<upper` pairs; plain specifier sets (`>=2.0,<3`) pass through, a
 * bare version is an exact pin, and `*` is a wildcard. `||` unions and
 * anything else non-evaluable become `unknown` with an empty specifier.
 */
export function translatePoetryRange(range: string): TranslatedRange {
	const value = range.trim();
	if (value === '' || value === '*') {
		return { specifier: '', rangeKind: 'wildcard' };
	}
	if (value.includes('||')) return { specifier: '', rangeKind: 'unknown' };

	if (
		value.startsWith('^') ||
		(value.startsWith('~') && !value.startsWith('~='))
	) {
		const lower = value.slice(1).trim();
		const parts = numericParts(lower);
		if (parts === null || parts.some(Number.isNaN)) {
			return { specifier: '', rangeKind: 'unknown' };
		}
		const upper = value.startsWith('^')
			? caretUpperBound(parts)
			: tildeUpperBound(parts);
		return { specifier: `>=${lower},<${upper}`, rangeKind: 'semver' };
	}

	// A bare version (`"2.26.0"`) is an exact pin in poetry.
	if (pep440Versioning.isValidVersion(value)) {
		return { specifier: `==${value}`, rangeKind: 'semver' };
	}

	const kind = pep440Versioning.classifyRange(value);
	return { specifier: kind === 'semver' ? value : '', rangeKind: kind };
}

/* -------------------------------------------------------------------------- */
/* Declaration extraction                                                     */
/* -------------------------------------------------------------------------- */

/** Build a declaration from a PEP 508 string, or `null` with a warning. */
function fromPep508(
	raw: string,
	depType: PypiDepType,
	warnings: string[]
): DeclaredPypiDep | null {
	const requirement = parsePep508(raw);
	if (requirement === null) {
		warnings.push(`pyproject.toml: could not parse dependency "${raw}"`);
		return null;
	}
	if (requirement.url !== undefined) {
		return {
			name: requirement.name,
			rawRange: raw,
			specifier: '',
			depType,
			rangeKind: requirement.url.startsWith('git+') ? 'git' : 'url',
		};
	}
	return {
		name: requirement.name,
		rawRange: raw,
		specifier: requirement.specifier,
		depType,
		rangeKind: pep440Versioning.classifyRange(requirement.specifier),
	};
}

/**
 * Build a declaration from one `[tool.poetry.*]` entry. Values are either a
 * constraint string (`"^2.0"`) or an inline table
 * (`{ version = "^2.0", extras = [...] }`, `{ git = "…" }`, `{ path = "…" }`).
 * A table with `optional = true` belongs to an extra, so it is demoted to
 * `optional` regardless of section.
 */
function fromPoetryEntry(
	name: string,
	value: unknown,
	depType: PypiDepType
): DeclaredPypiDep {
	const normalized = normalizePypiName(name);
	if (typeof value === 'string') {
		const { specifier, rangeKind } = translatePoetryRange(value);
		return {
			name: normalized,
			rawRange: value,
			specifier,
			depType,
			rangeKind,
		};
	}
	const table = record(value);
	if (table !== undefined) {
		const rawRange = JSON.stringify(value);
		const entryType: PypiDepType =
			table.optional === true ? 'optional' : depType;
		if (typeof table.git === 'string') {
			return {
				name: normalized,
				rawRange,
				specifier: '',
				depType: entryType,
				rangeKind: 'git',
			};
		}
		if (typeof table.path === 'string') {
			return {
				name: normalized,
				rawRange,
				specifier: '',
				depType: entryType,
				rangeKind: 'file',
			};
		}
		if (typeof table.url === 'string') {
			return {
				name: normalized,
				rawRange,
				specifier: '',
				depType: entryType,
				rangeKind: 'url',
			};
		}
		const { specifier, rangeKind } = translatePoetryRange(
			typeof table.version === 'string' ? table.version : '*'
		);
		return {
			name: normalized,
			rawRange,
			specifier,
			depType: entryType,
			rangeKind,
		};
	}
	// Multiple-constraints arrays and other exotic shapes: keep the row so the
	// dependency still counts as direct, but do not pretend to understand it.
	return {
		name: normalized,
		rawRange: JSON.stringify(value),
		specifier: '',
		depType,
		rangeKind: 'unknown',
	};
}

/**
 * Parse a `pyproject.toml` string into dependency declarations.
 *
 * Sources, in emission order:
 * - PEP 621 `[project].dependencies` (prod) and
 *   `[project.optional-dependencies].*` (optional)
 * - PEP 735 `[dependency-groups].*` (dev; `include-group` tables are skipped)
 * - `[tool.poetry.dependencies]` (prod; the interpreter constraint `python`
 *   is not a package and is skipped),
 *   `[tool.poetry.group.<g>.dependencies]` and the legacy
 *   `[tool.poetry.dev-dependencies]` (dev)
 *
 * Malformed TOML returns an empty result with a warning — never throws.
 */
export function parsePyproject(content: string): PyprojectResult {
	const warnings: string[] = [];
	let doc: Record<string, unknown>;
	try {
		doc = parseToml(content) as Record<string, unknown>;
	} catch (error) {
		return {
			declared: [],
			usesPoetry: false,
			warnings: [`pyproject.toml: ${(error as Error).message}`],
		};
	}

	const declared: DeclaredPypiDep[] = [];
	const push = (dep: DeclaredPypiDep | null) => {
		if (dep !== null) declared.push(dep);
	};

	// PEP 621.
	const project = record(doc.project);
	if (project !== undefined) {
		for (const raw of stringArray(project.dependencies)) {
			push(fromPep508(raw, 'prod', warnings));
		}
		const optionalGroups = record(project['optional-dependencies']);
		for (const entries of Object.values(optionalGroups ?? {})) {
			for (const raw of stringArray(entries)) {
				push(fromPep508(raw, 'optional', warnings));
			}
		}
	}

	// PEP 735 dependency groups are development-time by convention.
	const dependencyGroups = record(doc['dependency-groups']);
	for (const entries of Object.values(dependencyGroups ?? {})) {
		for (const raw of stringArray(entries)) {
			push(fromPep508(raw, 'dev', warnings));
		}
	}

	// Poetry.
	const poetry = record(record(doc.tool)?.poetry);
	const usesPoetry = poetry !== undefined;
	if (poetry !== undefined) {
		const main = record(poetry.dependencies) ?? {};
		for (const [name, value] of Object.entries(main)) {
			if (normalizePypiName(name) === 'python') continue;
			push(fromPoetryEntry(name, value, 'prod'));
		}
		const groups = record(poetry.group) ?? {};
		for (const group of Object.values(groups)) {
			const deps = record(record(group)?.dependencies) ?? {};
			for (const [name, value] of Object.entries(deps)) {
				push(fromPoetryEntry(name, value, 'dev'));
			}
		}
		const legacyDev = record(poetry['dev-dependencies']) ?? {};
		for (const [name, value] of Object.entries(legacyDev)) {
			push(fromPoetryEntry(name, value, 'dev'));
		}
	}

	const projectName = project?.name ?? poetry?.name;
	return {
		name: typeof projectName === 'string' ? projectName : undefined,
		declared,
		usesPoetry,
		warnings,
	};
}
