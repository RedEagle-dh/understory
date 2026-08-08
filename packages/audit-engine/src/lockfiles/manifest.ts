import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import picomatch from 'picomatch';
import { classifyRange } from '../ranges';
import type {
	DeclaredDependency,
	DepType,
	FileEntry,
	ManifestSet,
	WorkspaceManifest,
} from '../types';
import { basename, dirname, findRootManifest } from './detect';

/** Precedence used when one name is declared in several dependency sections. */
const DEP_TYPE_PRECEDENCE: Record<DepType, number> = {
	prod: 0,
	dev: 1,
	optional: 2,
	peer: 3,
	peer_optional: 4,
};

interface RawManifest {
	name?: string;
	version?: string;
	private?: boolean;
	packageManager?: string;
	workspaces?: string[] | { packages?: string[]; nohoist?: string[] };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	optionalDependencies?: Record<string, string>;
	catalog?: Record<string, string>;
	catalogs?: Record<string, Record<string, string>>;
}

/** Tolerant package.json parse (some repos ship comments / trailing commas). */
export function parseJsonManifest(content: string): {
	json: RawManifest | null;
	errors: string[];
} {
	const errors: ParseError[] = [];
	const json = parseJsonc(content, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	}) as unknown;
	const messages = errors.map(
		(error) => `offset ${error.offset}: parse error ${error.error}`
	);
	if (typeof json !== 'object' || json === null || Array.isArray(json)) {
		return { json: null, errors: messages };
	}
	return { json: json as RawManifest, errors: messages };
}

function workspacePatterns(manifest: RawManifest): string[] {
	const field = manifest.workspaces;
	if (Array.isArray(field)) return field.filter((p) => typeof p === 'string');
	if (
		field !== undefined &&
		field !== null &&
		Array.isArray(field.packages)
	) {
		return field.packages.filter((p) => typeof p === 'string');
	}
	return [];
}

/** Where `catalog:` ranges are looked up — root package.json or pnpm-workspace.yaml. */
interface CatalogSource {
	catalog?: Record<string, string>;
	catalogs?: Record<string, Record<string, string>>;
}

/**
 * Resolve `catalog:` / `catalog:<group>` protocol ranges against the workspace's
 * `catalog` / `catalogs` tables (bun & pnpm catalogs).
 */
function resolveCatalog(
	source: CatalogSource,
	name: string,
	rawRange: string
): string | undefined {
	if (!rawRange.startsWith('catalog:')) return undefined;
	const group = rawRange.slice('catalog:'.length).trim();
	if (group === '' || group === 'default') return source.catalog?.[name];
	return source.catalogs?.[group]?.[name];
}

function collectDeps(
	manifest: RawManifest,
	catalogSource: CatalogSource,
	warnings: string[],
	manifestPath: string
): DeclaredDependency[] {
	const out: DeclaredDependency[] = [];

	const push = (name: string, rawRange: string, depType: DepType) => {
		if (typeof name !== 'string' || name === '') return;
		if (typeof rawRange !== 'string') return;
		const resolved = resolveCatalog(catalogSource, name, rawRange);
		const range = resolved ?? rawRange;
		if (rawRange.startsWith('catalog:') && resolved === undefined) {
			warnings.push(
				`${manifestPath}: ${name} uses "${rawRange}" but no matching catalog entry was found`
			);
		}
		out.push({
			name,
			range,
			rawRange,
			rangeKind: classifyRange(range),
			depType,
		});
	};

	for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
		push(name, range, 'prod');
	}
	for (const [name, range] of Object.entries(
		manifest.devDependencies ?? {}
	)) {
		push(name, range, 'dev');
	}
	for (const [name, range] of Object.entries(
		manifest.optionalDependencies ?? {}
	)) {
		push(name, range, 'optional');
	}
	for (const [name, range] of Object.entries(
		manifest.peerDependencies ?? {}
	)) {
		const optional =
			manifest.peerDependenciesMeta?.[name]?.optional === true;
		push(name, range, optional ? 'peer_optional' : 'peer');
	}

	return out;
}

function indexByName(
	deps: DeclaredDependency[]
): Map<string, DeclaredDependency> {
	const byName = new Map<string, DeclaredDependency>();
	for (const dep of deps) {
		const existing = byName.get(dep.name);
		if (
			existing === undefined ||
			DEP_TYPE_PRECEDENCE[dep.depType] <
				DEP_TYPE_PRECEDENCE[existing.depType]
		) {
			byName.set(dep.name, dep);
		}
	}
	return byName;
}

export interface ParseManifestsOptions {
	/**
	 * Extra workspace globs, unioned with the root package.json's `workspaces`.
	 * pnpm declares its workspace members in `pnpm-workspace.yaml`, so without
	 * these every package in a pnpm monorepo looks unmatched.
	 */
	workspacePatterns?: readonly string[];
	/** Fallback `catalog:` tables, used for names the root manifest does not define. */
	catalog?: Record<string, string>;
	catalogs?: Record<string, Record<string, string>>;
}

/**
 * Parse every package.json in `files` into a workspace table.
 *
 * The shallowest package.json is the root. Its `workspaces` patterns are
 * matched (via picomatch, negations supported) against the directories of the
 * remaining manifests. Manifests that match no pattern are still recorded —
 * dropping them would silently lose direct dependencies — but produce a
 * warning.
 */
export function parseManifests(
	files: readonly FileEntry[],
	options: ParseManifestsOptions = {}
): ManifestSet {
	const warnings: string[] = [];
	const manifestFiles = files.filter(
		(file) =>
			basename(file.path) === 'package.json' &&
			!file.path.includes('node_modules/')
	);

	const rootFile = findRootManifest(manifestFiles);
	let rootJson: RawManifest | null = null;
	if (rootFile !== undefined) {
		const parsed = parseJsonManifest(rootFile.content);
		rootJson = parsed.json;
		for (const error of parsed.errors)
			warnings.push(`${rootFile.path}: ${error}`);
		if (rootJson === null) {
			warnings.push(`${rootFile.path}: not a JSON object; ignored`);
		}
	} else {
		warnings.push('no package.json found in the scanned file set');
	}

	const rootDir = rootFile === undefined ? '' : dirname(rootFile.path);
	// Root package.json entries win; pnpm-workspace.yaml fills the gaps.
	const catalogSource: CatalogSource = {
		catalog:
			rootJson?.catalog === undefined && options.catalog === undefined
				? undefined
				: { ...options.catalog, ...rootJson?.catalog },
		catalogs:
			rootJson?.catalogs === undefined && options.catalogs === undefined
				? undefined
				: { ...options.catalogs, ...rootJson?.catalogs },
	};
	const patterns = [
		...(rootJson === null ? [] : workspacePatterns(rootJson)),
		...(options.workspacePatterns ?? []),
	];
	const positive = patterns.filter((p) => !p.startsWith('!'));
	const negative = patterns
		.filter((p) => p.startsWith('!'))
		.map((p) => p.slice(1));
	const isPositive =
		positive.length > 0 ? picomatch(positive, { dot: true }) : () => false;
	const isNegative =
		negative.length > 0 ? picomatch(negative, { dot: true }) : () => false;

	const workspaces: WorkspaceManifest[] = [];
	const byPath = new Map<string, WorkspaceManifest>();

	for (const file of manifestFiles) {
		const isRoot = rootFile !== undefined && file.path === rootFile.path;
		const parsed = isRoot
			? { json: rootJson, errors: [] as string[] }
			: parseJsonManifest(file.content);
		for (const error of parsed.errors)
			warnings.push(`${file.path}: ${error}`);
		if (parsed.json === null) {
			if (!isRoot)
				warnings.push(`${file.path}: not a JSON object; ignored`);
			continue;
		}

		const dir = dirname(file.path);
		// Workspace path is relative to the root manifest's directory.
		const relative =
			rootDir === ''
				? dir
				: dir === rootDir
					? ''
					: dir.slice(rootDir.length + 1);
		const workspacePath = isRoot ? '' : relative;

		if (!isRoot) {
			const matched =
				isPositive(workspacePath) && !isNegative(workspacePath);
			if (!matched) {
				warnings.push(
					`${file.path}: not matched by the root "workspaces" patterns; treated as a standalone workspace`
				);
			}
		}

		const deps = collectDeps(
			parsed.json,
			catalogSource,
			warnings,
			file.path
		);
		const manifest: WorkspaceManifest = {
			path: workspacePath,
			manifestPath: file.path,
			isRoot,
			name:
				typeof parsed.json.name === 'string'
					? parsed.json.name
					: undefined,
			version:
				typeof parsed.json.version === 'string'
					? parsed.json.version
					: undefined,
			packageManager:
				typeof parsed.json.packageManager === 'string'
					? parsed.json.packageManager
					: undefined,
			deps,
			byName: indexByName(deps),
		};

		if (byPath.has(workspacePath)) {
			warnings.push(
				`${file.path}: duplicate workspace path "${workspacePath}"; ignored`
			);
			continue;
		}
		workspaces.push(manifest);
		byPath.set(workspacePath, manifest);
	}

	workspaces.sort((a, b) =>
		a.isRoot ? -1 : b.isRoot ? 1 : a.path.localeCompare(b.path)
	);

	return {
		root: workspaces.find((w) => w.isRoot),
		workspaces,
		byPath,
		catalog: catalogSource.catalog,
		catalogs: catalogSource.catalogs,
		warnings,
	};
}

/**
 * Resolve a `catalog:` / `catalog:<group>` protocol range against the root
 * manifest's catalogs. Returns the input unchanged for every other range.
 */
export function resolveCatalogRange(
	manifests: Pick<ManifestSet, 'catalog' | 'catalogs'>,
	name: string,
	rawRange: string
): string {
	if (!rawRange.startsWith('catalog:')) return rawRange;
	const group = rawRange.slice('catalog:'.length).trim();
	const resolved =
		group === '' || group === 'default'
			? manifests.catalog?.[name]
			: manifests.catalogs?.[group]?.[name];
	return resolved ?? rawRange;
}

/** Every workspace that declares `name`, root-first. */
export function workspacesDeclaring(
	manifests: ManifestSet,
	name: string
): WorkspaceManifest[] {
	return manifests.workspaces.filter((workspace) =>
		workspace.byName.has(name)
	);
}
