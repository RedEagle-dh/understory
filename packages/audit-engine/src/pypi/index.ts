import { dedupeDependencies } from '../lockfiles';
import type {
	DependencyGraph,
	FileEntry,
	PackageManager,
	ParsedDependency,
} from '../types';
import { detectPypiManager, findPypiFile } from './detect';
import { parsePoetryLock } from './poetry-lock';
import {
	type DeclaredPypiDep,
	declaredByName,
	parsePyproject,
} from './pyproject';
import { parseRequirementsTxt } from './requirements';
import { parseUvLock } from './uv-lock';

export * from './detect';
export * from './pep508';
export * from './poetry-lock';
export * from './pyproject';
export * from './requirements';
export * from './uv-lock';

/**
 * Parse a repository's Python manifests + lockfile into a
 * {@link DependencyGraph}.
 *
 * Declarations come from the shallowest `pyproject.toml` (plus
 * `requirements.txt` when the manager is pip); resolved versions come from
 * the manager's lockfile (`uv.lock` / `poetry.lock`) or, for pip, from exact
 * `==` pins. Directly declared packages that never appear in the lockfile are
 * skipped with a warning — a row without a resolved version cannot be matched
 * against advisories. The graph is always single-workspace (`''`): neither
 * poetry nor pip has workspaces, and uv workspace members are flattened.
 *
 * Pure and total: malformed inputs and missing files degrade to an empty
 * graph with warnings, never a throw.
 */
export function parsePypi(files: readonly FileEntry[]): DependencyGraph {
	const warnings: string[] = [];

	let manager: PackageManager | null = detectPypiManager(files);
	if (manager === null) {
		manager = 'pip';
		warnings.push(
			'no Python manifest or lockfile found; falling back to manager "pip"'
		);
	}

	let declared: DeclaredPypiDep[] = [];
	const pyproject = findPypiFile(files, 'pyproject.toml');
	if (pyproject !== undefined) {
		const result = parsePyproject(pyproject.content);
		declared = result.declared;
		warnings.push(...result.warnings);
	}

	let dependencies: ParsedDependency[] = [];

	if (manager === 'uv' || manager === 'poetry') {
		const lockName = manager === 'uv' ? 'uv.lock' : 'poetry.lock';
		const lockfile = findPypiFile(files, lockName);
		if (lockfile === undefined) {
			warnings.push(
				`${lockName} was not found; only declared ranges are known`
			);
		} else {
			const result =
				manager === 'uv'
					? parseUvLock(lockfile.content, declared)
					: parsePoetryLock(lockfile.content, declared);
			dependencies = result.dependencies;
			warnings.push(...result.warnings);

			// Declared but never locked: skip the row (no version to match
			// against advisories), but say so. Non-evaluable kinds (git, path,
			// …) legitimately resolve under a different install story.
			const locked = new Set(dependencies.map((dep) => dep.name));
			for (const dep of declaredByName(declared).values()) {
				if (locked.has(dep.name)) continue;
				if (dep.rangeKind !== 'semver' && dep.rangeKind !== 'wildcard')
					continue;
				warnings.push(
					`${dep.name} is declared but not present in the lockfile`
				);
			}
		}
	} else {
		const requirements = findPypiFile(files, 'requirements.txt');
		if (requirements !== undefined) {
			const result = parseRequirementsTxt(requirements.content);
			declared = [...declared, ...result.declared];
			dependencies = result.pinned;
			warnings.push(...result.warnings);
		}
		if (dependencies.length === 0) {
			warnings.push(
				'no lockfile or exact pins found; the dependency graph is empty'
			);
		}
	}

	return {
		ecosystem: 'pypi',
		manager,
		workspaces: [''],
		dependencies: dedupeDependencies(dependencies),
		warnings,
	};
}
