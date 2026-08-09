import { classifyRange } from '../ranges';
import type {
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
 * A dependency descriptor as written in a lockfile key: `lodash@^4.17.15`
 * (yarn 1) or `lodash@npm:^4.17.15` (berry).
 */
export interface YarnDescriptor {
	name: string;
	range: string;
}

/**
 * Split `name@range`.
 *
 * The split is at the FIRST `@` past position 0, not the last: a scoped name
 * starts with `@`, and an aliased range ends with one (`foo@npm:bar@^1.0.0`),
 * so only the first separator is unambiguous.
 */
export function parseYarnDescriptor(spec: string): YarnDescriptor | null {
	const trimmed = spec.trim().replace(/^"|"$/g, '');
	if (trimmed === '') return null;
	const at = trimmed.indexOf('@', 1);
	if (at === -1) return { name: trimmed, range: '' };
	return { name: trimmed.slice(0, at), range: trimmed.slice(at + 1) };
}

/**
 * Berry writes every registry range through the `npm:` protocol. Strip it so
 * the range classifies as `semver` rather than `alias` — but only when what
 * follows is a bare range; `npm:other-name@^1` really is an alias.
 */
export function stripNpmProtocol(range: string): string {
	if (!range.startsWith('npm:')) return range;
	const rest = range.slice(4);
	return rest.indexOf('@', 1) === -1 ? rest : range;
}

interface YarnEntry {
	id: number;
	descriptors: YarnDescriptor[];
	name: string;
	version: string;
	/** Set when the entry is a workspace (`name@workspace:apps/web`), not a package. */
	workspacePath?: string;
	deps: Record<string, string>;
	devDeps: Record<string, string>;
	optionalDeps: Record<string, string>;
	peerDeps?: Record<string, PeerRequirement>;
}

/* -------------------------------------------------------------------------- */
/* yarn 1 — a bespoke indentation format, not YAML                            */
/* -------------------------------------------------------------------------- */

/** `key "value"` / `key value` / `"key" "value"`. */
function splitPair(line: string): { key: string; value: string } | null {
	const trimmed = line.trim();
	if (trimmed === '') return null;
	if (trimmed.startsWith('"')) {
		const close = trimmed.indexOf('"', 1);
		if (close === -1) return null;
		return {
			key: trimmed.slice(1, close),
			value: unquote(trimmed.slice(close + 1).trim()),
		};
	}
	const space = trimmed.indexOf(' ');
	if (space === -1) return { key: trimmed, value: '' };
	return {
		key: trimmed.slice(0, space),
		value: unquote(trimmed.slice(space + 1).trim()),
	};
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1);
	}
	return value;
}

function indentOf(line: string): number {
	let count = 0;
	while (line[count] === ' ') count++;
	return count;
}

const NESTED_BLOCKS = new Set([
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
	'peerDependenciesMeta',
]);

/**
 * Parse the classic (yarn 1) lockfile.
 *
 * Entries start at column 0 with a comma-separated descriptor list ending in
 * `:`; fields are indented two spaces, and `dependencies:`-style blocks nest
 * their members two deeper.
 */
export function parseYarnV1(content: string): {
	entries: YarnEntry[];
	warnings: string[];
} {
	const warnings: string[] = [];
	const entries: YarnEntry[] = [];
	let current: YarnEntry | null = null;
	let block: string | null = null;
	let metaTarget: string | null = null;

	for (const rawLine of content.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const indent = indentOf(line);

		if (indent === 0) {
			if (!trimmed.endsWith(':')) {
				warnings.push(
					`yarn.lock: unexpected top-level line "${trimmed.slice(0, 80)}"`
				);
				continue;
			}
			const descriptors = trimmed
				.slice(0, -1)
				.split(',')
				.map((part) => parseYarnDescriptor(part))
				.filter((d): d is YarnDescriptor => d !== null);
			if (descriptors.length === 0) continue;
			current = {
				id: entries.length,
				descriptors,
				name: descriptors[0]?.name ?? '',
				version: '',
				deps: {},
				devDeps: {},
				optionalDeps: {},
			};
			entries.push(current);
			block = null;
			metaTarget = null;
			continue;
		}

		if (current === null) continue;

		if (indent === 2) {
			block = null;
			metaTarget = null;
			if (trimmed.endsWith(':') && NESTED_BLOCKS.has(trimmed.slice(0, -1))) {
				block = trimmed.slice(0, -1);
				continue;
			}
			const pair = splitPair(trimmed);
			if (pair === null) continue;
			if (pair.key === 'version') current.version = pair.value;
			continue;
		}

		if (block === null) continue;

		if (indent === 4) {
			if (block === 'peerDependenciesMeta') {
				metaTarget = trimmed.endsWith(':')
					? unquote(trimmed.slice(0, -1))
					: null;
				continue;
			}
			const pair = splitPair(trimmed);
			if (pair === null) continue;
			if (block === 'dependencies') current.deps[pair.key] = pair.value;
			else if (block === 'devDependencies')
				current.devDeps[pair.key] = pair.value;
			else if (block === 'optionalDependencies')
				current.optionalDeps[pair.key] = pair.value;
			else if (block === 'peerDependencies') {
				current.peerDeps ??= {};
				current.peerDeps[pair.key] = {
					range: pair.value,
					optional: false,
				};
			}
			continue;
		}

		if (indent >= 6 && block === 'peerDependenciesMeta' && metaTarget !== null) {
			const pair = splitPair(trimmed.replace(/:\s*/, ' '));
			if (pair?.key === 'optional' && pair.value === 'true') {
				current.peerDeps ??= {};
				const existing = current.peerDeps[metaTarget];
				current.peerDeps[metaTarget] = {
					range: existing?.range ?? '*',
					optional: true,
				};
			}
		}
	}

	return { entries, warnings };
}

/* -------------------------------------------------------------------------- */
/* berry (yarn 2+) — real YAML                                                */
/* -------------------------------------------------------------------------- */

function peerDepsFrom(
	entry: Record<string, unknown>
): Record<string, PeerRequirement> | undefined {
	const peers = asStringMap(entry.peerDependencies);
	const names = Object.keys(peers);
	if (names.length === 0) return undefined;
	const meta = asMapping(entry.peerDependenciesMeta);
	const out: Record<string, PeerRequirement> = {};
	for (const name of names) {
		out[name] = {
			range: peers[name] as string,
			optional: asMapping(meta?.[name])?.optional === true,
		};
	}
	return out;
}

export function parseYarnBerry(content: string): {
	entries: YarnEntry[];
	warnings: string[];
} {
	const parsed = parseYamlMapping(content, 'yarn.lock');
	const warnings = [...parsed.warnings];
	const entries: YarnEntry[] = [];
	if (parsed.json === undefined) return { entries, warnings };

	for (const [key, value] of Object.entries(parsed.json)) {
		if (key === '__metadata') continue;
		const entry = asMapping(value);
		if (entry === undefined) continue;
		const descriptors = key
			.split(',')
			.map((part) => parseYarnDescriptor(part))
			.filter((d): d is YarnDescriptor => d !== null);
		if (descriptors.length === 0) continue;

		const resolution =
			typeof entry.resolution === 'string'
				? parseYarnDescriptor(entry.resolution)
				: null;
		const workspaceRange = resolution?.range.startsWith('workspace:')
			? resolution.range.slice('workspace:'.length)
			: undefined;

		entries.push({
			id: entries.length,
			descriptors,
			name: resolution?.name ?? descriptors[0]?.name ?? '',
			version:
				typeof entry.version === 'string'
					? entry.version
					: typeof entry.version === 'number'
						? String(entry.version)
						: '',
			workspacePath:
				workspaceRange === undefined
					? undefined
					: workspaceRange === '.'
						? ''
						: workspaceRange,
			deps: asStringMap(entry.dependencies),
			devDeps: asStringMap(entry.devDependencies),
			optionalDeps: asStringMap(entry.optionalDependencies),
			peerDeps: peerDepsFrom(entry),
		});
	}

	return { entries, warnings };
}

/* -------------------------------------------------------------------------- */
/* Shared graph construction                                                  */
/* -------------------------------------------------------------------------- */

/** Berry stamps `__metadata` at the head of the file; yarn 1 never does. */
export function isBerryLockfile(content: string): boolean {
	return /^__metadata:/m.test(content);
}

const SECTIONS: { field: 'deps' | 'devDeps' | 'optionalDeps'; depType: DepType }[] =
	[
		{ field: 'deps', depType: 'prod' },
		{ field: 'devDeps', depType: 'dev' },
		{ field: 'optionalDeps', depType: 'optional' },
	];

/**
 * Parse a `yarn.lock` of either generation into the shared graph shape.
 *
 * Neither format records whether a package is a dev or optional dependency —
 * yarn resolves one flat descriptor table for the whole workspace — so dep
 * types come from walking outward from the declared roots
 * ({@link walkReachable}). Roots come from the lockfile's own `workspace:`
 * entries under berry, and from the parsed manifests under yarn 1, which has
 * no workspace records at all.
 */
export function parseYarnLock(
	content: string,
	manifests: ManifestSet
): LockParseResult {
	const berry = isBerryLockfile(content);
	const parsed = berry ? parseYarnBerry(content) : parseYarnV1(content);
	const warnings = [...parsed.warnings];
	const entries = parsed.entries;

	/** Every descriptor spelling that reaches an entry. */
	const byDescriptor = new Map<string, YarnEntry>();
	for (const entry of entries) {
		for (const descriptor of entry.descriptors) {
			byDescriptor.set(`${descriptor.name}@${descriptor.range}`, entry);
		}
	}

	const resolve = (name: string, range: string): YarnEntry | undefined => {
		const direct = byDescriptor.get(`${name}@${range}`);
		if (direct !== undefined) return direct;
		// Berry manifests declare `^4.17.15`; the lockfile keys it as
		// `npm:^4.17.15`. Try the protocol form before giving up.
		if (berry && !range.includes(':')) {
			return byDescriptor.get(`${name}@npm:${range}`);
		}
		return undefined;
	};

	const workspaceSet = new Set<string>(['']);
	for (const workspace of manifests.workspaces) workspaceSet.add(workspace.path);

	interface DirectHit {
		workspace: string;
		name: string;
		depType: DepType;
		rawRange: string;
		entry: YarnEntry;
	}

	const direct: DirectHit[] = [];
	const roots: { key: number; tag: ReachTag }[] = [];

	const addDirect = (hit: DirectHit): void => {
		direct.push(hit);
		roots.push({ key: hit.entry.id, tag: tagForDepType(hit.depType) });
	};

	const workspaceEntries = entries.filter(
		(entry) => entry.workspacePath !== undefined
	);

	if (workspaceEntries.length > 0) {
		// Berry: the lockfile itself knows every workspace and its declarations.
		for (const entry of workspaceEntries) {
			const workspace = entry.workspacePath as string;
			workspaceSet.add(workspace);
			for (const section of SECTIONS) {
				for (const [name, range] of Object.entries(entry[section.field])) {
					const target = resolve(name, range);
					// `workspace:` ranges point at a sibling package, not an install.
					if (target === undefined || target.workspacePath !== undefined) {
						continue;
					}
					addDirect({
						workspace,
						name,
						depType: section.depType,
						rawRange: stripNpmProtocol(range),
						entry: target,
					});
				}
			}
		}
	} else {
		// yarn 1: descriptors are the only index, so declarations come from the
		// manifests and are matched on the range exactly as written.
		for (const workspace of manifests.workspaces) {
			workspaceSet.add(workspace.path);
			for (const declared of workspace.byName.values()) {
				if (
					declared.rangeKind === 'workspace' ||
					declared.rangeKind === 'link' ||
					declared.rangeKind === 'file'
				) {
					continue;
				}
				const range = resolveCatalogRange(
					manifests,
					declared.name,
					declared.rawRange
				);
				const target =
					resolve(declared.name, declared.rawRange) ??
					resolve(declared.name, range);
				if (target === undefined) {
					if (
						declared.rangeKind === 'semver' ||
						declared.rangeKind === 'tag' ||
						declared.rangeKind === 'wildcard'
					) {
						warnings.push(
							`yarn.lock: ${declared.name} is declared in workspace "${workspace.path}" but "${declared.rawRange}" was not found in the lockfile`
						);
					}
					continue;
				}
				addDirect({
					workspace: workspace.path,
					name: declared.name,
					depType: declared.depType,
					rawRange: declared.rawRange,
					entry: target,
				});
			}
		}
	}

	const reached = walkReachable(roots, (key) => {
		const entry = entries[key];
		if (entry === undefined) return undefined;
		const toIds = (block: Record<string, string>): number[] => {
			const out: number[] = [];
			for (const [name, range] of Object.entries(block)) {
				const target = resolve(name, range);
				if (target !== undefined && target.workspacePath === undefined) {
					out.push(target.id);
				}
			}
			return out;
		};
		return {
			deps: toIds(entry.deps),
			optionalDeps: toIds(entry.optionalDeps),
		};
	});

	const dependencies: ParsedDependency[] = [];
	const consumed = new Set<number>();

	for (const hit of direct) {
		if (hit.entry.version === '') continue;
		consumed.add(hit.entry.id);
		const range = resolveCatalogRange(manifests, hit.name, hit.rawRange);
		dependencies.push({
			name: hit.name,
			version: hit.entry.version,
			workspace: hit.workspace,
			depType: hit.depType,
			isDirect: true,
			depth: 0,
			declaredRange: range === '' ? undefined : range,
			rawRange: hit.rawRange === '' ? undefined : hit.rawRange,
			peerDeps: hit.entry.peerDeps,
		});
	}

	for (const entry of entries) {
		if (entry.workspacePath !== undefined) continue;
		if (consumed.has(entry.id)) continue;
		if (entry.version === '') {
			warnings.push(
				`yarn.lock: entry "${entry.descriptors[0]?.name ?? '?'}" has no version; skipped`
			);
			continue;
		}
		const hit = reached.get(entry.id);
		dependencies.push({
			name: entry.name,
			version: entry.version,
			workspace: '',
			depType: hit?.tag ?? 'prod',
			isDirect: false,
			depth: hit?.depth ?? 1,
			peerDeps: entry.peerDeps,
		});
	}

	if (entries.length === 0) {
		warnings.push('yarn.lock: no entries were parsed');
	}

	return {
		dependencies,
		workspaces: [...workspaceSet].sort(),
		warnings,
	};
}

/** Unused today, kept aligned with the other parsers' exported helpers. */
export type { YarnEntry };

/** Range classification for a berry descriptor, protocol stripped. */
export function classifyYarnRange(range: string) {
	return classifyRange(stripNpmProtocol(range));
}
