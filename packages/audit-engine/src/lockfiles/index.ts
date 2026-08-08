import type {
	DependencyGraph,
	FileEntry,
	PackageManager,
	ParsedDependency,
} from '../types';
import { parseBunLock } from './bun-lock';
import {
	basename,
	detectManager,
	findLockfile,
	managerFromPackageManagerField,
} from './detect';
import { parseManifests } from './manifest';
import { parsePackageLock } from './package-lock';
import { parsePnpmLock, parsePnpmWorkspaceYaml } from './pnpm-lock';
import { parseYarnLock } from './yarn-lock';

export * from './bun-lock';
export * from './detect';
export * from './manifest';
export * from './package-lock';
export * from './pnpm-lock';
export * from './reachability';
export * from './yaml';
export * from './yarn-lock';

/** Dedupe key required by the design: `(workspace, name, version, depType)`. */
function dedupeKey(dependency: ParsedDependency): string {
	return [
		dependency.workspace,
		dependency.name,
		dependency.version,
		dependency.depType,
	].join('\u0000');
}

/**
 * Collapse duplicates, keeping the most informative row: a direct occurrence
 * beats a transitive one, the shallowest depth wins, and peer requirements /
 * declared ranges are carried over.
 */
export function dedupeDependencies(
	dependencies: readonly ParsedDependency[]
): ParsedDependency[] {
	const merged = new Map<string, ParsedDependency>();
	for (const dependency of dependencies) {
		const key = dedupeKey(dependency);
		const existing = merged.get(key);
		if (existing === undefined) {
			merged.set(key, { ...dependency });
			continue;
		}
		existing.isDirect = existing.isDirect || dependency.isDirect;
		existing.depth = Math.min(existing.depth, dependency.depth);
		existing.declaredRange ??= dependency.declaredRange;
		existing.rawRange ??= dependency.rawRange;
		existing.resolved ??= dependency.resolved;
		existing.deprecated ??= dependency.deprecated;
		if (dependency.peerDeps !== undefined) {
			existing.peerDeps = {
				...dependency.peerDeps,
				...existing.peerDeps,
			};
		}
	}
	return [...merged.values()];
}

/**
 * Parse a repository's manifests + lockfile into a {@link DependencyGraph}.
 *
 * `files` is the set of package.json / lockfile blobs discovered by the scan
 * service. Nothing here touches the network or the filesystem.
 */
export function parseLockfile(files: readonly FileEntry[]): DependencyGraph {
	// pnpm keeps workspace globs AND catalogs outside package.json, so this has
	// to be read before the manifests are indexed.
	const workspaceYaml = files.find(
		(file) =>
			basename(file.path) === 'pnpm-workspace.yaml' &&
			!file.path.includes('node_modules/')
	);
	const pnpmWorkspace =
		workspaceYaml === undefined
			? undefined
			: parsePnpmWorkspaceYaml(workspaceYaml.content);

	const manifests = parseManifests(files, {
		workspacePatterns: pnpmWorkspace?.patterns,
		catalog: pnpmWorkspace?.catalog,
		catalogs: pnpmWorkspace?.catalogs,
	});
	const warnings = [...manifests.warnings, ...(pnpmWorkspace?.warnings ?? [])];

	let manager: PackageManager | null = detectManager(files);
	if (manager === null) {
		manager = managerFromPackageManagerField(files) ?? 'npm';
		warnings.push(
			`no lockfile found; falling back to manager "${manager}" — only declared ranges are known`
		);
	}

	const workspaceSet = new Set<string>(['']);
	for (const workspace of manifests.workspaces)
		workspaceSet.add(workspace.path);

	let dependencies: ParsedDependency[] = [];
	const lockfile = findLockfile(files, manager);

	if (lockfile === undefined) {
		// Detection succeeded via `packageManager` but no lockfile blob exists.
		if (detectManager(files) !== null) {
			warnings.push(
				`lockfile for manager "${manager}" was detected but not fetched`
			);
		}
	} else if (manager === 'npm') {
		const result = parsePackageLock(lockfile.content, manifests);
		dependencies = result.dependencies;
		for (const workspace of result.workspaces) workspaceSet.add(workspace);
		warnings.push(...result.warnings);
	} else if (manager === 'bun') {
		if (lockfile.path.endsWith('.lockb')) {
			warnings.push(
				'bun.lockb is a binary lockfile and cannot be parsed; run `bun install --save-text-lockfile` to produce bun.lock'
			);
		} else {
			const result = parseBunLock(lockfile.content, manifests);
			dependencies = result.dependencies;
			for (const workspace of result.workspaces)
				workspaceSet.add(workspace);
			warnings.push(...result.warnings);
		}
	} else if (manager === 'pnpm') {
		const result = parsePnpmLock(lockfile.content, manifests);
		dependencies = result.dependencies;
		for (const workspace of result.workspaces) workspaceSet.add(workspace);
		warnings.push(...result.warnings);
	} else if (manager === 'yarn') {
		const result = parseYarnLock(lockfile.content, manifests);
		dependencies = result.dependencies;
		for (const workspace of result.workspaces) workspaceSet.add(workspace);
		warnings.push(...result.warnings);
	} else {
		warnings.push(
			`lockfiles for "${manager}" are not supported yet; no transitive dependencies were parsed`
		);
	}

	return {
		ecosystem: 'npm',
		manager,
		workspaces: [...workspaceSet].sort(),
		dependencies: dedupeDependencies(dependencies),
		warnings,
	};
}
