import { parse as parseToml } from 'smol-toml';
import { basename } from '../lockfiles';
import type { FileEntry, PackageManager } from '../types';

const PYPI_LOCKFILE_MANAGERS: Record<string, PackageManager> = {
	'uv.lock': 'uv',
	'poetry.lock': 'poetry',
	'requirements.txt': 'pip',
};

/** When several Python lockfiles tie at the same depth. */
const PRIORITY: PackageManager[] = ['uv', 'poetry', 'pip'];

const PYPI_BASENAMES = new Set([
	'pyproject.toml',
	'uv.lock',
	'poetry.lock',
	'requirements.txt',
]);

function pathDepth(path: string): number {
	return path.split('/').length;
}

/** Virtualenvs and vendored trees must never influence detection. */
function isVendored(path: string): boolean {
	return (
		path.includes('.venv/') ||
		path.includes('site-packages/') ||
		path.includes('node_modules/')
	);
}

/**
 * The shallowest, lexicographically-first file with the given basename,
 * skipping vendored paths. Python manifests have fixed names, so this is how
 * the repository-root `pyproject.toml` / lockfile is picked over nested
 * examples.
 */
export function findPypiFile(
	files: readonly FileEntry[],
	name: string
): FileEntry | undefined {
	let best: FileEntry | undefined;
	for (const file of files) {
		if (basename(file.path) !== name) continue;
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

/** `true` when the file set contains any Python manifest or lockfile. */
export function isPypiPresent(files: readonly FileEntry[]): boolean {
	return files.some(
		(file) =>
			PYPI_BASENAMES.has(basename(file.path)) && !isVendored(file.path)
	);
}

/**
 * Detect the Python package manager from the files present.
 *
 * Only the shallowest lockfiles count (a nested example project must not
 * outvote the repository root); ties are broken by a fixed priority
 * (uv > poetry > pip). Requirements files count as pip's "lockfile" here —
 * they are the closest thing pip has.
 *
 * Without any lockfile, the shallowest `pyproject.toml` is sniffed for a
 * `[tool.uv]` or `[tool.poetry]` section; a bare PEP 621 manifest falls back
 * to `pip`. Returns `null` when no Python manifest exists at all.
 */
export function detectPypiManager(
	files: readonly FileEntry[]
): PackageManager | null {
	let bestDepth = Number.POSITIVE_INFINITY;
	const found = new Map<PackageManager, number>();

	for (const file of files) {
		if (isVendored(file.path)) continue;
		const manager = PYPI_LOCKFILE_MANAGERS[basename(file.path)];
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

	if (candidates.length === 1) return candidates[0] as PackageManager;
	if (candidates.length > 1) {
		for (const manager of PRIORITY) {
			if (candidates.includes(manager)) return manager;
		}
	}

	const pyproject = findPypiFile(files, 'pyproject.toml');
	if (pyproject === undefined) return null;
	try {
		const doc = parseToml(pyproject.content) as Record<string, unknown>;
		const tool = doc.tool;
		if (typeof tool === 'object' && tool !== null && !Array.isArray(tool)) {
			if ('uv' in tool) return 'uv';
			if ('poetry' in tool) return 'poetry';
		}
	} catch {
		// Malformed pyproject.toml still marks a Python project; assume pip.
	}
	return 'pip';
}
