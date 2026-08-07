import { parse as parseToml } from 'smol-toml';
import { normalizePypiName } from '../pep440';
import type { DepType, ParsedDependency } from '../types';
import { type DeclaredPypiDep, declaredByName } from './pyproject';
import type { PypiLockParseResult } from './uv-lock';

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

/**
 * Dep type of a locked package that is not declared directly.
 *
 * `optional = true` means the package only installs via an extra. Newer
 * lockfiles carry `groups = ["main"|"dev", …]` per package; a package that
 * appears in no non-dev group is dev-only. Legacy lockfiles (poetry < 1.5)
 * use `category = "main" | "dev"` instead.
 */
function transitiveDepType(pkg: Record<string, unknown>): DepType {
	if (pkg.optional === true) return 'optional';
	if (Array.isArray(pkg.groups)) {
		const groups = pkg.groups.filter(
			(group): group is string => typeof group === 'string'
		);
		if (groups.length > 0 && !groups.includes('main')) return 'dev';
		return 'prod';
	}
	if (pkg.category === 'dev') return 'dev';
	return 'prod';
}

/**
 * Parse a `poetry.lock` (TOML).
 *
 * The format is a flat list of `[[package]]` entries with `name`, `version`,
 * an `optional` flag and either `groups` (newer) or `category` (legacy).
 * Unlike `uv.lock` the project itself never appears as a package, so every
 * entry is a dependency.
 *
 * Direct/`depType` attribution comes from matching `declared` (the
 * pyproject.toml declarations) by normalized name; unmatched packages are
 * transitive at depth 1 (poetry does not record tree depth) with the dep type
 * their `groups`/`category`/`optional` metadata implies. Workspace is `''`
 * for everything — poetry has no workspace concept.
 *
 * Malformed TOML returns an empty result with a warning — never throws.
 */
export function parsePoetryLock(
	content: string,
	declared: readonly DeclaredPypiDep[]
): PypiLockParseResult {
	const warnings: string[] = [];
	let doc: Record<string, unknown>;
	try {
		doc = parseToml(content) as Record<string, unknown>;
	} catch (error) {
		return {
			dependencies: [],
			warnings: [`poetry.lock: ${(error as Error).message}`],
		};
	}

	const packages = Array.isArray(doc.package) ? doc.package : [];
	const byName = declaredByName(declared);
	const dependencies: ParsedDependency[] = [];

	for (const entry of packages) {
		const pkg = record(entry);
		if (pkg === undefined) continue;

		const name = pkg.name;
		const version = pkg.version;
		if (
			typeof name !== 'string' ||
			name === '' ||
			typeof version !== 'string' ||
			version === ''
		) {
			warnings.push(
				'poetry.lock: package entry without name or version; skipped'
			);
			continue;
		}

		const normalized = normalizePypiName(name);
		const direct = byName.get(normalized);
		if (direct !== undefined) {
			dependencies.push({
				name: normalized,
				version,
				workspace: '',
				depType: direct.depType,
				isDirect: true,
				depth: 0,
				declaredRange: direct.specifier,
				rawRange: direct.rawRange,
			});
		} else {
			dependencies.push({
				name: normalized,
				version,
				workspace: '',
				depType: transitiveDepType(pkg),
				isDirect: false,
				depth: 1,
			});
		}
	}

	return { dependencies, warnings };
}
