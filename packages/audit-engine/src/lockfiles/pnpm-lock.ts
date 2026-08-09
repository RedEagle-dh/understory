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
import { type ReachTag, tagForDepType, walkReachable } from './reachability';
import { asMapping, asStringMap, parseYamlMapping } from './yaml';

/**
 * How package keys are spelled, which changed with the lockfile format:
 *
 * - `slash` (lockfileVersion ≤ 5.4, pnpm ≤ 7): `/lodash/4.17.21`, peer context
 *   appended after an underscore (`/react-dom/17.0.2_react@17.0.2`).
 * - `at` (lockfileVersion 6 and 9, pnpm ≥ 8): `lodash@4.17.21` — optionally
 *   with a leading `/` in v6 — and peer context in parentheses
 *   (`react-dom@18.2.0(react@18.2.0)`).
 */
type KeyStyle = 'slash' | 'at';

export interface PnpmPackageKey {
	name: string;
	version: string;
}

/**
 * Split a pnpm package/snapshot key into name and version.
 *
 * The peer-context suffix is stripped: two entries that differ only by the
 * peers they were resolved against are the same physical package version, and
 * advisories are matched on `(name, version)`.
 */
export function parsePnpmPackageKey(
	key: string,
	style: KeyStyle
): PnpmPackageKey | null {
	let rest = key.startsWith('/') ? key.slice(1) : key;
	if (rest === '') return null;

	if (style === 'slash') {
		const lastSlash = rest.lastIndexOf('/');
		if (lastSlash <= 0) return null;
		// The peer suffix lives inside the version segment, so only look for the
		// underscore *after* the final `/` — package names may contain one.
		const underscore = rest.indexOf('_', lastSlash);
		if (underscore !== -1) rest = rest.slice(0, underscore);
		const slash = rest.lastIndexOf('/');
		if (slash <= 0) return null;
		const name = rest.slice(0, slash);
		const version = rest.slice(slash + 1);
		if (name === '' || version === '') return null;
		return { name, version };
	}

	const paren = rest.indexOf('(');
	if (paren !== -1) rest = rest.slice(0, paren);
	const at = rest.lastIndexOf('@');
	if (at <= 0) return null;
	const name = rest.slice(0, at);
	const version = rest.slice(at + 1);
	if (name === '' || version === '') return null;
	return { name, version };
}

/** `9.0` / `'6.0'` / `5.4` → the key spelling that release used. */
function keyStyleFor(raw: unknown): KeyStyle {
	const numeric =
		typeof raw === 'number'
			? raw
			: typeof raw === 'string'
				? Number.parseFloat(raw)
				: Number.NaN;
	if (Number.isNaN(numeric)) return 'at';
	return numeric < 6 ? 'slash' : 'at';
}

/** The lockfile key an importer's resolved `version` field points at. */
function importerKey(name: string, version: string, style: KeyStyle): string {
	return style === 'slash' ? `/${name}/${version}` : `${name}@${version}`;
}

/** `link:../shared`, `file:./vendor/x` — a path, not an installed package. */
function isLocalLink(version: string): boolean {
	return version.startsWith('link:') || version.startsWith('file:');
}

interface PnpmNode {
	key: string;
	name: string;
	version: string;
	/** Edge target keys, exactly as spelled in the lockfile. */
	deps: string[];
	optionalDeps: string[];
	/** v5/v6 stamp these on the entry; v9 does not. */
	dev?: boolean;
	optional?: boolean;
}

interface PnpmPackageMeta {
	peerDeps?: Record<string, PeerRequirement>;
	deprecated?: string;
}

function peerDepsFrom(
	entry: Record<string, unknown>
): Record<string, PeerRequirement> | undefined {
	const peers = asStringMap(entry.peerDependencies);
	const names = Object.keys(peers);
	if (names.length === 0) return undefined;
	const meta = asMapping(entry.peerDependenciesMeta);
	const out: Record<string, PeerRequirement> = {};
	for (const name of names) {
		const flags = asMapping(meta?.[name]);
		out[name] = {
			range: peers[name] as string,
			optional: flags?.optional === true,
		};
	}
	return out;
}

function edgeKeys(
	section: unknown,
	style: KeyStyle
): { keys: string[]; unresolved: string[] } {
	const keys: string[] = [];
	const unresolved: string[] = [];
	for (const [name, version] of Object.entries(asStringMap(section))) {
		if (isLocalLink(version)) continue;
		keys.push(importerKey(name, version, style));
		// Aliased installs (`myalias: lodash@4.17.21`) spell the target as the
		// bare spec; keep it as a fallback lookup.
		unresolved.push(version);
	}
	return { keys, unresolved };
}

/**
 * Parse a `pnpm-lock.yaml` (lockfileVersion 5.4, 6.0 and 9.0).
 *
 * v9 splits the file in two: `packages` holds per-version metadata (peers,
 * deprecation) keyed *without* peer context, while `snapshots` holds the
 * dependency edges keyed *with* it. v5/v6 keep both on a single `packages`
 * entry. Both shapes are normalized onto {@link PnpmNode} before anything else
 * looks at them.
 */
export function parsePnpmLock(
	content: string,
	manifests: ManifestSet
): LockParseResult {
	const parsed = parseYamlMapping(content, 'pnpm-lock.yaml');
	const warnings = [...parsed.warnings];
	const json = parsed.json;
	if (json === undefined) {
		return { dependencies: [], workspaces: [''], warnings };
	}

	const style = keyStyleFor(json.lockfileVersion);

	/* ------------------------------------------------------------------ */
	/* Package metadata (peers, deprecation)                              */
	/* ------------------------------------------------------------------ */

	const packagesSection = asMapping(json.packages) ?? {};
	const snapshotsSection = asMapping(json.snapshots);

	/** Keyed by `name\0version` — peer context stripped. */
	const metaByVersion = new Map<string, PnpmPackageMeta>();
	for (const [key, value] of Object.entries(packagesSection)) {
		const entry = asMapping(value);
		if (entry === undefined) continue;
		const parsedKey = parsePnpmPackageKey(key, style);
		if (parsedKey === null) {
			warnings.push(
				`pnpm-lock.yaml: could not parse package key "${key}"; skipped`
			);
			continue;
		}
		metaByVersion.set(`${parsedKey.name}\u0000${parsedKey.version}`, {
			peerDeps: peerDepsFrom(entry),
			deprecated:
				typeof entry.deprecated === 'string'
					? entry.deprecated
					: undefined,
		});
	}

	/* ------------------------------------------------------------------ */
	/* Nodes + edges                                                      */
	/* ------------------------------------------------------------------ */

	// v9 keeps edges in `snapshots`; older versions keep them on `packages`.
	const edgeSource = snapshotsSection ?? packagesSection;
	const nodes = new Map<string, PnpmNode>();
	/** Fallback index for aliased installs, `name@version` → real key. */
	const nodeByBareSpec = new Map<string, string>();

	for (const [key, value] of Object.entries(edgeSource)) {
		const entry = asMapping(value) ?? {};
		const parsedKey = parsePnpmPackageKey(key, style);
		if (parsedKey === null) {
			if (snapshotsSection !== undefined) {
				warnings.push(
					`pnpm-lock.yaml: could not parse snapshot key "${key}"; skipped`
				);
			}
			continue;
		}
		const deps = edgeKeys(entry.dependencies, style);
		const optional = edgeKeys(entry.optionalDependencies, style);
		nodes.set(key, {
			key,
			name: parsedKey.name,
			version: parsedKey.version,
			deps: deps.keys,
			optionalDeps: optional.keys,
			dev: entry.dev === true ? true : undefined,
			optional: entry.optional === true ? true : undefined,
		});
		nodeByBareSpec.set(
			`${parsedKey.name}@${parsedKey.version}`,
			nodeByBareSpec.get(`${parsedKey.name}@${parsedKey.version}`) ?? key
		);
	}

	/** Resolve an edge/importer target onto a real node key. */
	const resolveKey = (candidate: string): string | undefined => {
		if (nodes.has(candidate)) return candidate;
		// Aliased install: the recorded version is itself a full spec.
		const bare = nodeByBareSpec.get(candidate);
		if (bare !== undefined) return bare;
		return undefined;
	};

	/* ------------------------------------------------------------------ */
	/* Importers → direct dependencies                                    */
	/* ------------------------------------------------------------------ */

	const workspaceSet = new Set<string>(['']);
	for (const workspace of manifests.workspaces) workspaceSet.add(workspace.path);

	// A single-package repo has no `importers` section: v5/v6 hoist the root
	// package's `dependencies` / `devDependencies` / `specifiers` to the top
	// level of the document, so the document itself is the sole importer.
	const importers = asMapping(json.importers) ?? { '.': json };

	const SECTIONS: { field: string; depType: DepType }[] = [
		{ field: 'dependencies', depType: 'prod' },
		{ field: 'devDependencies', depType: 'dev' },
		{ field: 'optionalDependencies', depType: 'optional' },
	];

	interface DirectHit {
		workspace: string;
		declared: DeclaredDependency;
		nodeKey: string;
	}

	const direct: DirectHit[] = [];
	const roots: { key: string; tag: ReachTag }[] = [];

	for (const [importerPath, value] of Object.entries(importers)) {
		const importer = asMapping(value);
		if (importer === undefined) continue;
		const workspace = importerPath === '.' ? '' : importerPath;
		workspaceSet.add(workspace);

		// v5 keeps declared ranges in a sibling `specifiers` map instead of
		// inlining them next to each resolved version.
		const legacySpecifiers = asStringMap(importer.specifiers);

		for (const section of SECTIONS) {
			const block = asMapping(importer[section.field]);
			if (block === undefined) continue;
			for (const [name, raw] of Object.entries(block)) {
				let specifier: string | undefined;
				let version: string | undefined;
				if (typeof raw === 'string') {
					version = raw;
					specifier = legacySpecifiers[name];
				} else {
					const entry = asMapping(raw);
					if (entry === undefined) continue;
					if (typeof entry.specifier === 'string')
						specifier = entry.specifier;
					if (typeof entry.version === 'string')
						version = entry.version;
				}
				if (version === undefined || version === '') continue;
				// `link:` targets another workspace, not an installed package.
				if (isLocalLink(version)) continue;

				const nodeKey = resolveKey(
					importerKey(name, version, style)
				) ?? resolveKey(version);
				if (nodeKey === undefined) {
					warnings.push(
						`pnpm-lock.yaml: ${name} is declared in importer "${importerPath}" but "${version}" was not found in the lockfile`
					);
					continue;
				}

				const rawRange =
					specifier ??
					manifests.byPath.get(workspace)?.byName.get(name)
						?.rawRange ??
					'';
				const range = resolveCatalogRange(manifests, name, rawRange);
				direct.push({
					workspace,
					nodeKey,
					declared: {
						name,
						range,
						rawRange,
						rangeKind: classifyRange(range),
						depType: section.depType,
					},
				});
				roots.push({
					key: nodeKey,
					tag: tagForDepType(section.depType),
				});
			}
		}
	}

	if (direct.length === 0 && nodes.size > 0) {
		warnings.push(
			'pnpm-lock.yaml: no importer declared any dependency; every package was treated as transitive'
		);
	}

	/* ------------------------------------------------------------------ */
	/* Reachability + emit                                                */
	/* ------------------------------------------------------------------ */

	const reached = walkReachable(roots, (key) => nodes.get(key));

	const dependencies: ParsedDependency[] = [];
	const consumed = new Set<string>();

	for (const hit of direct) {
		const node = nodes.get(hit.nodeKey);
		if (node === undefined) continue;
		consumed.add(hit.nodeKey);
		const meta = metaByVersion.get(`${node.name}\u0000${node.version}`);
		dependencies.push({
			name: node.name,
			version: node.version,
			workspace: hit.workspace,
			depType: hit.declared.depType,
			isDirect: true,
			depth: 0,
			declaredRange: hit.declared.range === '' ? undefined : hit.declared.range,
			rawRange:
				hit.declared.rawRange === '' ? undefined : hit.declared.rawRange,
			peerDeps: meta?.peerDeps,
			deprecated: meta?.deprecated,
		});
	}

	for (const node of nodes.values()) {
		if (consumed.has(node.key)) continue;
		const meta = metaByVersion.get(`${node.name}\u0000${node.version}`);
		const hit = reached.get(node.key);
		const depType: DepType =
			node.dev === true
				? 'dev'
				: node.optional === true
					? 'optional'
					: (hit?.tag ?? 'prod');
		dependencies.push({
			name: node.name,
			version: node.version,
			workspace: '',
			depType,
			isDirect: false,
			// Unreachable entries (stale rows pnpm has not pruned) sit at 1.
			depth: hit?.depth ?? 1,
			peerDeps: meta?.peerDeps,
			deprecated: meta?.deprecated,
		});
	}

	return {
		dependencies,
		workspaces: [...workspaceSet].sort(),
		warnings,
	};
}

/**
 * Read `pnpm-workspace.yaml`: pnpm keeps its workspace globs AND its catalogs
 * there rather than in the root `package.json`, so without this a pnpm monorepo
 * looks like a pile of unrelated packages and every `catalog:` range fails to
 * resolve.
 */
export function parsePnpmWorkspaceYaml(content: string): {
	patterns: string[];
	catalog?: Record<string, string>;
	catalogs?: Record<string, Record<string, string>>;
	warnings: string[];
} {
	const parsed = parseYamlMapping(content, 'pnpm-workspace.yaml');
	if (parsed.json === undefined) {
		return { patterns: [], warnings: parsed.warnings };
	}
	const raw = parsed.json.packages;
	const patterns = Array.isArray(raw)
		? raw.filter((entry): entry is string => typeof entry === 'string')
		: [];

	const catalog = asStringMap(parsed.json.catalog);
	const catalogsMapping = asMapping(parsed.json.catalogs);
	let catalogs: Record<string, Record<string, string>> | undefined;
	if (catalogsMapping !== undefined) {
		catalogs = {};
		for (const [group, entries] of Object.entries(catalogsMapping)) {
			catalogs[group] = asStringMap(entries);
		}
	}

	return {
		patterns,
		catalog: Object.keys(catalog).length === 0 ? undefined : catalog,
		catalogs,
		warnings: parsed.warnings,
	};
}
