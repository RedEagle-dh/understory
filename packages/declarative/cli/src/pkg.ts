import { join } from 'node:path';

interface PackageJsonShape {
	dependencies?: Record<string, string>;
	[key: string]: unknown;
}

function isPackageJson(value: unknown): value is PackageJsonShape {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Version to pin a newly-added dependency at. */
function versionFor(pkg: string): string {
	// Workspace packages resolve locally; external packages default to latest.
	return pkg.startsWith('@declarativejs/') ? 'workspace:*' : 'latest';
}

/**
 * Adds or removes a dependency in the app's package.json, keeping the map
 * sorted. Only bare package specifiers are managed (local `./…` module paths
 * are not dependencies). Uses a type-predicate parse — no `any`/`as`.
 */
export async function editDependency(
	projectRoot: string,
	action: 'add' | 'remove',
	pkg: string
): Promise<void> {
	if (pkg.startsWith('.')) return;
	const path = join(projectRoot, 'package.json');
	const parsed: unknown = JSON.parse(await Bun.file(path).text());
	if (!isPackageJson(parsed)) {
		throw new Error(`invalid package.json at ${path}`);
	}
	const dependencies: Record<string, string> = { ...parsed.dependencies };
	if (action === 'add') {
		if (dependencies[pkg] === undefined) dependencies[pkg] = versionFor(pkg);
	} else {
		delete dependencies[pkg];
	}
	const sorted = Object.fromEntries(
		Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))
	);
	const updated = { ...parsed, dependencies: sorted };
	await Bun.write(path, `${JSON.stringify(updated, null, '\t')}\n`);
}
