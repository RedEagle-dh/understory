import { classifyRange } from '../ranges';
import type {
	DeclaredDependency,
	DepType,
	ManifestSet,
	ParsedDependency,
	PeerRequirement,
} from '../types';

export interface LockParseResult {
	dependencies: ParsedDependency[];
	workspaces: string[];
	warnings: string[];
}

interface PackageLockEntry {
	name?: string;
	version?: string;
	resolved?: string;
	link?: boolean;
	dev?: boolean;
	optional?: boolean;
	devOptional?: boolean;
	peer?: boolean;
	deprecated?: string | boolean;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	workspaces?: string[];
}

interface PackageLockV1Node {
	version?: string;
	resolved?: string;
	dev?: boolean;
	optional?: boolean;
	requires?: Record<string, string> | boolean;
	dependencies?: Record<string, PackageLockV1Node>;
}

interface PackageLockJson {
	lockfileVersion?: number;
	name?: string;
	packages?: Record<string, PackageLockEntry>;
	dependencies?: Record<string, PackageLockV1Node>;
}

const NM = 'node_modules/';

interface KeyParts {
	/** Workspace directory the `node_modules` tree hangs off (`''` = root). */
	prefix: string;
	name: string;
	/** Number of `node_modules/` segments in the key. */
	depth: number;
}

/**
 * Split a v2/v3 `packages` key.
 *
 * `node_modules/@scope/pkg/node_modules/bar` → `{prefix:'', name:'bar', depth:2}`
 * `apps/web/node_modules/foo` → `{prefix:'apps/web', name:'foo', depth:1}`
 *
 * Splitting on the literal `node_modules/` separator keeps scoped names intact,
 * so `@scope/pkg` is always counted as one package.
 */
export function splitPackageLockKey(key: string): KeyParts | null {
	const index = key.indexOf(NM);
	if (index === -1) return null;
	const prefix = key.slice(0, index).replace(/\/$/, '');
	const rest = key.slice(index);
	const parts = rest.split(NM);
	const depth = parts.length - 1;
	const name = (parts[parts.length - 1] ?? '').replace(/\/$/, '');
	if (name === '') return null;
	return { prefix, name, depth };
}

function depTypeFromFlags(entry: PackageLockEntry): DepType {
	if (entry.peer === true)
		return entry.optional === true ? 'peer_optional' : 'peer';
	if (entry.dev === true || entry.devOptional === true) return 'dev';
	if (entry.optional === true) return 'optional';
	return 'prod';
}

function extractPeerDeps(entry: {
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}): Record<string, PeerRequirement> | undefined {
	const peers = entry.peerDependencies;
	if (peers === undefined || Object.keys(peers).length === 0)
		return undefined;
	const out: Record<string, PeerRequirement> = {};
	for (const [name, range] of Object.entries(peers)) {
		out[name] = {
			range,
			optional: entry.peerDependenciesMeta?.[name]?.optional === true,
		};
	}
	return out;
}

function declarationsFromEntry(
	entry: PackageLockEntry
): Map<string, DeclaredDependency> {
	const map = new Map<string, DeclaredDependency>();
	const add = (name: string, rawRange: string, depType: DepType) => {
		if (map.has(name)) return;
		map.set(name, {
			name,
			range: rawRange,
			rawRange,
			rangeKind: classifyRange(rawRange),
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
	for (const [name, range] of Object.entries(entry.peerDependencies ?? {})) {
		add(
			name,
			range,
			entry.peerDependenciesMeta?.[name]?.optional === true
				? 'peer_optional'
				: 'peer'
		);
	}
	return map;
}

/**
 * Parse an npm `package-lock.json` (v2/v3 `packages` map, with a best-effort
 * fallback for the v1 nested `dependencies` tree).
 */
export function parsePackageLock(
	content: string,
	manifests: ManifestSet
): LockParseResult {
	const warnings: string[] = [];
	let json: PackageLockJson;
	try {
		json = JSON.parse(content) as PackageLockJson;
	} catch (error) {
		return {
			dependencies: [],
			workspaces: [''],
			warnings: [`package-lock.json: ${(error as Error).message}`],
		};
	}

	if (json.packages !== undefined && json.packages !== null) {
		return parseV2(json, manifests, warnings);
	}
	if (json.dependencies !== undefined && json.dependencies !== null) {
		warnings.push(
			`package-lock.json: lockfileVersion ${json.lockfileVersion ?? 1} has no "packages" map; using the v1 fallback parser`
		);
		return parseV1(json, manifests, warnings);
	}
	warnings.push(
		'package-lock.json: neither "packages" nor "dependencies" present'
	);
	return { dependencies: [], workspaces: [''], warnings };
}

function parseV2(
	json: PackageLockJson,
	manifests: ManifestSet,
	warnings: string[]
): LockParseResult {
	const packages = json.packages ?? {};
	const dependencies: ParsedDependency[] = [];
	const workspaceSet = new Set<string>(['']);
	for (const workspace of manifests.workspaces)
		workspaceSet.add(workspace.path);

	// Pass 1 — classify keys, collect workspace directories and local copies.
	const entries: { key: string; parts: KeyParts; entry: PackageLockEntry }[] =
		[];
	const declarations = new Map<string, Map<string, DeclaredDependency>>();
	for (const workspace of manifests.workspaces) {
		declarations.set(workspace.path, workspace.byName);
	}

	for (const [key, entry] of Object.entries(packages)) {
		if (entry === null || typeof entry !== 'object') continue;
		if (key === '') {
			if (!declarations.has(''))
				declarations.set('', declarationsFromEntry(entry));
			continue;
		}
		const parts = splitPackageLockKey(key);
		if (parts === null) {
			// A workspace package directory, e.g. `apps/web`.
			workspaceSet.add(key);
			if (!declarations.has(key))
				declarations.set(key, declarationsFromEntry(entry));
			continue;
		}
		entries.push({ key, parts, entry });
	}

	const localCopies = new Set<string>();
	for (const { parts } of entries) {
		// Only a workspace-local install shadows the hoisted copy at the tree root.
		if (parts.depth === 1 && parts.prefix !== '')
			localCopies.add(`${parts.prefix}\u0000${parts.name}`);
	}

	const emittedDirect = new Set<string>();

	// Pass 2 — emit dependencies.
	for (const { key, parts, entry } of entries) {
		if (entry.link === true) {
			// Workspace symlink: `node_modules/web` → `apps/web`.
			if (typeof entry.resolved === 'string' && entry.resolved !== '') {
				workspaceSet.add(entry.resolved.replace(/^\.\//, ''));
			}
			continue;
		}
		const version = entry.version;
		if (typeof version !== 'string' || version === '') {
			warnings.push(
				`package-lock.json: entry "${key}" has no version; skipped`
			);
			continue;
		}

		const peerDeps = extractPeerDeps(entry);
		const deprecated =
			typeof entry.deprecated === 'string' ? entry.deprecated : undefined;

		const directTargets: {
			workspace: string;
			declared: DeclaredDependency;
		}[] = [];
		if (parts.depth === 1) {
			if (parts.prefix === '') {
				for (const [workspacePath, byName] of declarations) {
					const declared = byName.get(parts.name);
					if (declared === undefined) continue;
					// The workspace has its own nested copy — this hoisted entry
					// belongs to somebody else.
					if (localCopies.has(`${workspacePath}\u0000${parts.name}`))
						continue;
					directTargets.push({ workspace: workspacePath, declared });
				}
			} else {
				const declared = declarations
					.get(parts.prefix)
					?.get(parts.name);
				if (declared !== undefined) {
					directTargets.push({ workspace: parts.prefix, declared });
				}
			}
		}

		if (directTargets.length > 0) {
			for (const target of directTargets) {
				emittedDirect.add(`${target.workspace}\u0000${parts.name}`);
				dependencies.push({
					name: parts.name,
					version,
					workspace: target.workspace,
					depType: target.declared.depType,
					isDirect: true,
					depth: 0,
					declaredRange: target.declared.range,
					rawRange: target.declared.rawRange,
					peerDeps,
					resolved: entry.resolved,
					deprecated,
				});
			}
			continue;
		}

		dependencies.push({
			name: parts.name,
			version,
			workspace: parts.prefix,
			depType: depTypeFromFlags(entry),
			isDirect: false,
			depth: parts.depth,
			peerDeps,
			resolved: entry.resolved,
			deprecated,
		});
	}

	// Declared but unresolved dependencies are worth a warning.
	for (const [workspacePath, byName] of declarations) {
		for (const declared of byName.values()) {
			if (emittedDirect.has(`${workspacePath}\u0000${declared.name}`))
				continue;
			if (
				declared.rangeKind !== 'semver' &&
				declared.rangeKind !== 'tag' &&
				declared.rangeKind !== 'wildcard'
			) {
				continue;
			}
			warnings.push(
				`package-lock.json: ${declared.name} is declared in workspace "${workspacePath}" but was not found in the lockfile`
			);
		}
	}

	return {
		dependencies,
		workspaces: [...workspaceSet].sort(),
		warnings,
	};
}

function parseV1(
	json: PackageLockJson,
	manifests: ManifestSet,
	warnings: string[]
): LockParseResult {
	const dependencies: ParsedDependency[] = [];
	const rootDeclarations =
		manifests.root?.byName ?? new Map<string, DeclaredDependency>();

	const walk = (
		nodes: Record<string, PackageLockV1Node>,
		depth: number
	): void => {
		for (const [name, node] of Object.entries(nodes)) {
			if (node === null || typeof node !== 'object') continue;
			const version = node.version;
			if (typeof version === 'string' && version !== '') {
				const declared =
					depth === 1 ? rootDeclarations.get(name) : undefined;
				if (declared !== undefined) {
					dependencies.push({
						name,
						version,
						workspace: '',
						depType: declared.depType,
						isDirect: true,
						depth: 0,
						declaredRange: declared.range,
						rawRange: declared.rawRange,
						resolved: node.resolved,
					});
				} else {
					dependencies.push({
						name,
						version,
						workspace: '',
						depType:
							node.dev === true
								? 'dev'
								: node.optional === true
									? 'optional'
									: 'prod',
						isDirect: false,
						depth,
						resolved: node.resolved,
					});
				}
			} else {
				warnings.push(
					`package-lock.json (v1): entry "${name}" has no version; skipped`
				);
			}
			if (node.dependencies !== undefined && node.dependencies !== null) {
				walk(node.dependencies, depth + 1);
			}
		}
	};

	walk(json.dependencies ?? {}, 1);

	return { dependencies, workspaces: [''], warnings };
}
