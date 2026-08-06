import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { classifyRange } from '../ranges';
import type {
	DeclaredDependency,
	DepType,
	ManifestSet,
	ParsedDependency,
	PeerRequirement,
} from '../types';
import { resolveCatalogRange } from './manifest';
import type { LockParseResult } from './package-lock';

interface BunWorkspaceEntry {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	optionalDependencies?: Record<string, string>;
	optionalPeers?: string[];
}

interface BunPackageMeta {
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	optionalPeers?: string[];
	bin?: unknown;
	os?: unknown;
	cpu?: unknown;
	bundled?: boolean;
}

interface BunLockJson {
	lockfileVersion?: number;
	configVersion?: number;
	workspaces?: Record<string, BunWorkspaceEntry>;
	packages?: Record<string, unknown[]>;
	patchedDependencies?: Record<string, string>;
	overrides?: Record<string, string>;
}

/** Reachability tag; lower wins when a package is reachable several ways. */
const TAG_RANK: Record<'prod' | 'optional' | 'dev', number> = {
	prod: 0,
	optional: 1,
	dev: 2,
};

/**
 * Split a `bun.lock` package key into its path segments.
 *
 * The key encodes tree nesting with `/`, but scoped names contain a `/` too, so
 * a segment is either `@scope/name` (consuming two `/`-parts) or `name`.
 *
 * `"@tailwindcss/oxide-wasm32-wasi/@napi-rs/wasm-runtime"` →
 * `['@tailwindcss/oxide-wasm32-wasi', '@napi-rs/wasm-runtime']`
 */
export function splitBunLockKey(key: string): string[] {
	const parts = key.split('/');
	const segments: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index] as string;
		if (part.startsWith('@') && index + 1 < parts.length) {
			segments.push(`${part}/${parts[index + 1]}`);
			index++;
		} else {
			segments.push(part);
		}
	}
	return segments;
}

/** Split `"name@version"` — the name may itself be scoped, so split at the LAST `@`. */
export function splitNameVersion(spec: string): {
	name: string;
	version: string;
} {
	const at = spec.lastIndexOf('@');
	if (at <= 0) return { name: spec, version: '' };
	return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function findMeta(tuple: unknown[]): BunPackageMeta | undefined {
	for (let index = 1; index < tuple.length; index++) {
		const candidate = tuple[index];
		if (
			typeof candidate === 'object' &&
			candidate !== null &&
			!Array.isArray(candidate)
		) {
			return candidate as BunPackageMeta;
		}
	}
	return undefined;
}

function peerDepsFromMeta(meta: BunPackageMeta | undefined) {
	const peers = meta?.peerDependencies;
	if (peers === undefined || Object.keys(peers).length === 0)
		return undefined;
	const optional = new Set(meta?.optionalPeers ?? []);
	const out: Record<string, PeerRequirement> = {};
	for (const [name, range] of Object.entries(peers)) {
		out[name] = { range, optional: optional.has(name) };
	}
	return out;
}

function declarationsFromWorkspaceEntry(
	entry: BunWorkspaceEntry,
	manifests: ManifestSet
): Map<string, DeclaredDependency> {
	const map = new Map<string, DeclaredDependency>();
	const add = (name: string, rawRange: string, depType: DepType) => {
		if (map.has(name)) return;
		// bun.lock stores the literal `catalog:` protocol; resolve it against
		// the root manifest so downstream range maths still works.
		const range = resolveCatalogRange(manifests, name, rawRange);
		map.set(name, {
			name,
			range,
			rawRange,
			rangeKind: classifyRange(range),
			depType,
		});
	};
	for (const [name, range] of Object.entries(entry.dependencies ?? {}))
		add(name, range, 'prod');
	for (const [name, range] of Object.entries(entry.devDependencies ?? {}))
		add(name, range, 'dev');
	for (const [name, range] of Object.entries(
		entry.optionalDependencies ?? {}
	)) {
		add(name, range, 'optional');
	}
	const optionalPeers = new Set(entry.optionalPeers ?? []);
	for (const [name, range] of Object.entries(entry.peerDependencies ?? {})) {
		const optional =
			optionalPeers.has(name) ||
			entry.peerDependenciesMeta?.[name]?.optional === true;
		add(name, range, optional ? 'peer_optional' : 'peer');
	}
	return map;
}

interface BunPackage {
	key: string;
	segments: string[];
	name: string;
	version: string;
	meta?: BunPackageMeta;
	/** `workspace:<path>` entries are symlinks, not installed packages. */
	workspacePath?: string;
}

/**
 * Parse a `bun.lock` file. The format is JSONC (trailing commas), so it is read
 * with `jsonc-parser` rather than `JSON.parse`.
 */
export function parseBunLock(
	content: string,
	manifests: ManifestSet
): LockParseResult {
	const warnings: string[] = [];
	const parseErrors: ParseError[] = [];
	const json = parseJsonc(content, parseErrors, {
		allowTrailingComma: true,
		disallowComments: false,
	}) as BunLockJson | undefined;

	for (const error of parseErrors) {
		warnings.push(
			`bun.lock: parse error ${error.error} at offset ${error.offset}`
		);
	}
	if (json === undefined || typeof json !== 'object' || json === null) {
		return { dependencies: [], workspaces: [''], warnings };
	}

	/* ---------------------------------------------------------------- */
	/* Workspaces + declarations                                        */
	/* ---------------------------------------------------------------- */

	const workspaceSet = new Set<string>(['']);
	const declarations = new Map<string, Map<string, DeclaredDependency>>();

	for (const workspace of manifests.workspaces) {
		workspaceSet.add(workspace.path);
		declarations.set(workspace.path, workspace.byName);
	}
	for (const [path, entry] of Object.entries(json.workspaces ?? {})) {
		if (entry === null || typeof entry !== 'object') continue;
		workspaceSet.add(path);
		if (!declarations.has(path)) {
			declarations.set(
				path,
				declarationsFromWorkspaceEntry(entry, manifests)
			);
		}
	}
	if (declarations.size === 0) {
		warnings.push(
			'bun.lock: no workspaces section and no package.json files provided'
		);
	}

	/* ---------------------------------------------------------------- */
	/* Packages                                                         */
	/* ---------------------------------------------------------------- */

	const packages = new Map<string, BunPackage>();
	for (const [key, value] of Object.entries(json.packages ?? {})) {
		if (!Array.isArray(value) || value.length === 0) {
			warnings.push(
				`bun.lock: package entry "${key}" is not a tuple; skipped`
			);
			continue;
		}
		const spec = value[0];
		if (typeof spec !== 'string') {
			warnings.push(
				`bun.lock: package entry "${key}" has no "name@version" spec; skipped`
			);
			continue;
		}
		const { name, version } = splitNameVersion(spec);
		const segments = splitBunLockKey(key);
		if (version.startsWith('workspace:')) {
			const path = version.slice('workspace:'.length);
			if (path !== '' && path !== '*') workspaceSet.add(path);
			packages.set(key, {
				key,
				segments,
				name,
				version,
				workspacePath: path,
			});
			continue;
		}
		packages.set(key, {
			key,
			segments,
			name,
			version,
			meta: findMeta(value),
		});
	}

	/**
	 * Resolve `name` as seen from the package at `fromKey`, walking up the
	 * nesting path exactly like a `node_modules` lookup.
	 */
	const resolve = (fromKey: string, name: string): BunPackage | undefined => {
		const segments = fromKey === '' ? [] : splitBunLockKey(fromKey);
		for (let depth = segments.length; depth >= 0; depth--) {
			const candidate = [...segments.slice(0, depth), name].join('/');
			const found = packages.get(candidate);
			if (found !== undefined) return found;
		}
		return undefined;
	};

	/* ---------------------------------------------------------------- */
	/* Reachability: bun.lock does not tag entries dev/optional          */
	/* ---------------------------------------------------------------- */

	const tags = new Map<string, 'prod' | 'optional' | 'dev'>();
	const queue: { key: string; tag: 'prod' | 'optional' | 'dev' }[] = [];

	const visit = (key: string, tag: 'prod' | 'optional' | 'dev') => {
		const existing = tags.get(key);
		if (existing !== undefined && TAG_RANK[existing] <= TAG_RANK[tag])
			return;
		tags.set(key, tag);
		queue.push({ key, tag });
	};

	for (const byName of declarations.values()) {
		for (const declared of byName.values()) {
			const target = resolve('', declared.name);
			if (target === undefined || target.workspacePath !== undefined)
				continue;
			const tag: 'prod' | 'optional' | 'dev' =
				declared.depType === 'dev'
					? 'dev'
					: declared.depType === 'optional'
						? 'optional'
						: 'prod';
			if (
				declared.depType === 'peer' ||
				declared.depType === 'peer_optional'
			)
				continue;
			visit(target.key, tag);
		}
	}

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		const pkg = packages.get(current.key);
		if (pkg === undefined || pkg.meta === undefined) continue;
		for (const name of Object.keys(pkg.meta.dependencies ?? {})) {
			const target = resolve(pkg.key, name);
			if (target !== undefined && target.workspacePath === undefined) {
				visit(target.key, current.tag);
			}
		}
		for (const name of Object.keys(pkg.meta.optionalDependencies ?? {})) {
			const target = resolve(pkg.key, name);
			if (target !== undefined && target.workspacePath === undefined) {
				visit(
					target.key,
					current.tag === 'prod' ? 'optional' : current.tag
				);
			}
		}
	}

	/* ---------------------------------------------------------------- */
	/* Emit                                                             */
	/* ---------------------------------------------------------------- */

	const dependencies: ParsedDependency[] = [];
	const consumed = new Set<string>();

	const workspacePaths = [...declarations.keys()].sort();
	for (const workspacePath of workspacePaths) {
		const byName = declarations.get(workspacePath);
		if (byName === undefined) continue;
		for (const declared of byName.values()) {
			const target = resolve('', declared.name);
			if (target === undefined) {
				if (
					declared.rangeKind === 'semver' ||
					declared.rangeKind === 'tag' ||
					declared.rangeKind === 'wildcard'
				) {
					warnings.push(
						`bun.lock: ${declared.name} is declared in workspace "${workspacePath}" but was not found in the lockfile`
					);
				}
				continue;
			}
			// `workspace:*` dependencies point at another workspace, not at an
			// installed package.
			if (target.workspacePath !== undefined) continue;
			consumed.add(target.key);
			dependencies.push({
				name: target.name,
				version: target.version,
				workspace: workspacePath,
				depType: declared.depType,
				isDirect: true,
				depth: 0,
				declaredRange: declared.range,
				rawRange: declared.rawRange,
				peerDeps: peerDepsFromMeta(target.meta),
			});
		}
	}

	for (const pkg of packages.values()) {
		if (pkg.workspacePath !== undefined) continue;
		if (consumed.has(pkg.key)) continue;
		const tag = tags.get(pkg.key);
		dependencies.push({
			name: pkg.name,
			version: pkg.version,
			workspace: '',
			depType: tag === undefined ? 'prod' : tag,
			isDirect: false,
			depth: pkg.segments.length,
			peerDeps: peerDepsFromMeta(pkg.meta),
		});
	}

	return {
		dependencies,
		workspaces: [...workspaceSet].sort(),
		warnings,
	};
}
