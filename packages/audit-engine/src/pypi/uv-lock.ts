import { parse as parseToml } from 'smol-toml';
import { normalizePypiName } from '../pep440';
import type { ParsedDependency } from '../types';
import { type DeclaredPypiDep, declaredByName } from './pyproject';

export interface PypiLockParseResult {
	dependencies: ParsedDependency[];
	warnings: string[];
}

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
 * Parse a `uv.lock` (TOML).
 *
 * The format is a flat list of `[[package]]` entries with `name`, `version`
 * and a `source` table. The project itself appears as a package whose source
 * is `{ virtual = "." }` or `{ editable = "." }` — it carries the direct
 * dependency lists and is not emitted as a dependency.
 *
 * Direct/`depType` attribution comes from matching `declared` (the
 * pyproject.toml declarations) by normalized name; every other locked package
 * is a transitive prod dependency at depth 1 — uv's lockfile does not record
 * per-package tree depth, so `1` simply means "not direct". Workspaces are
 * flattened to `''`: when several virtual/editable members exist, a warning
 * notes that member attribution is lost.
 *
 * Malformed TOML returns an empty result with a warning — never throws.
 */
export function parseUvLock(
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
			warnings: [`uv.lock: ${(error as Error).message}`],
		};
	}

	const packages = Array.isArray(doc.package) ? doc.package : [];
	const byName = declaredByName(declared);
	const dependencies: ParsedDependency[] = [];
	let rootCount = 0;

	for (const entry of packages) {
		const pkg = record(entry);
		if (pkg === undefined) continue;

		const source = record(pkg.source);
		if (
			source !== undefined &&
			('virtual' in source || 'editable' in source)
		) {
			// The project (or a workspace member) itself — not a dependency.
			rootCount++;
			continue;
		}

		const name = pkg.name;
		const version = pkg.version;
		if (
			typeof name !== 'string' ||
			name === '' ||
			typeof version !== 'string' ||
			version === ''
		) {
			warnings.push(
				'uv.lock: package entry without name or version; skipped'
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
				depType: 'prod',
				isDirect: false,
				depth: 1,
			});
		}
	}

	if (rootCount > 1) {
		warnings.push(
			'uv.lock: multiple workspace members found; member attribution is flattened to the repository root'
		);
	}

	return { dependencies, warnings };
}
