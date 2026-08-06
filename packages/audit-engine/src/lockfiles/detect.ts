import { parse as parseJsonc } from 'jsonc-parser';
import type { FileEntry, PackageManager } from '../types';

const LOCKFILE_MANAGERS: Record<string, PackageManager> = {
	'package-lock.json': 'npm',
	'npm-shrinkwrap.json': 'npm',
	'bun.lock': 'bun',
	'bun.lockb': 'bun',
	'yarn.lock': 'yarn',
	'pnpm-lock.yaml': 'pnpm',
};

/** When several lockfiles are present and package.json gives no hint. */
const PRIORITY: PackageManager[] = ['npm', 'bun', 'pnpm', 'yarn'];

export function basename(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? path : path.slice(index + 1);
}

export function dirname(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

function pathDepth(path: string): number {
	return path.split('/').length;
}

function isVendored(path: string): boolean {
	return path.includes('node_modules/') || path.startsWith('node_modules/');
}

/** The shallowest, lexicographically-first package.json in the file set. */
export function findRootManifest(
	files: readonly FileEntry[]
): FileEntry | undefined {
	let best: FileEntry | undefined;
	for (const file of files) {
		if (basename(file.path) !== 'package.json') continue;
		if (isVendored(file.path)) continue;
		if (
			best === undefined ||
			pathDepth(file.path) < pathDepth(best.path) ||
			(pathDepth(file.path) === pathDepth(best.path) &&
				file.path < best.path)
		) {
			best = file;
		}
	}
	return best;
}

/**
 * Read the `packageManager` field (`"bun@1.3.14"`) of the root package.json and
 * map it onto a {@link PackageManager}.
 */
export function managerFromPackageManagerField(
	files: readonly FileEntry[]
): PackageManager | null {
	const root = findRootManifest(files);
	if (root === undefined) return null;
	let json: unknown;
	try {
		json = parseJsonc(root.content, [], { allowTrailingComma: true });
	} catch {
		return null;
	}
	if (typeof json !== 'object' || json === null) return null;
	const field = (json as { packageManager?: unknown }).packageManager;
	if (typeof field !== 'string') return null;
	const name = field.split('@')[0]?.trim().toLowerCase();
	if (
		name === 'npm' ||
		name === 'bun' ||
		name === 'yarn' ||
		name === 'pnpm'
	) {
		return name;
	}
	return null;
}

/**
 * Detect the package manager from the lockfiles present in `files`.
 *
 * Only the shallowest lockfiles are considered (a nested example project must
 * not outvote the repository root). When several managers tie, the
 * `packageManager` field of the root package.json wins; otherwise a fixed
 * priority (npm > bun > pnpm > yarn) decides.
 *
 * Returns `null` when the file set contains no lockfile at all.
 */
export function detectManager(
	files: readonly FileEntry[]
): PackageManager | null {
	let bestDepth = Number.POSITIVE_INFINITY;
	const found = new Map<PackageManager, number>();

	for (const file of files) {
		if (isVendored(file.path)) continue;
		const manager = LOCKFILE_MANAGERS[basename(file.path)];
		if (manager === undefined) continue;
		const depth = pathDepth(file.path);
		const existing = found.get(manager);
		if (existing === undefined || depth < existing)
			found.set(manager, depth);
		if (depth < bestDepth) bestDepth = depth;
	}

	const candidates = [...found.entries()]
		.filter(([, depth]) => depth === bestDepth)
		.map(([manager]) => manager);

	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0] as PackageManager;

	const declared = managerFromPackageManagerField(files);
	if (declared !== null && candidates.includes(declared)) return declared;

	for (const manager of PRIORITY) {
		if (candidates.includes(manager)) return manager;
	}
	return candidates[0] as PackageManager;
}

/** The lockfile that {@link detectManager} would pick, if any. */
export function findLockfile(
	files: readonly FileEntry[],
	manager: PackageManager
): FileEntry | undefined {
	let best: FileEntry | undefined;
	for (const file of files) {
		if (isVendored(file.path)) continue;
		if (LOCKFILE_MANAGERS[basename(file.path)] !== manager) continue;
		if (best === undefined || pathDepth(file.path) < pathDepth(best.path)) {
			best = file;
		}
	}
	return best;
}
