import { describe, expect, test } from 'bun:test';
import {
	detectManager,
	parseLockfile,
	parseManifests,
	parsePackageLock,
	splitBunLockKey,
	splitNameVersion,
	splitPackageLockKey,
} from '../lockfiles';
import type { DependencyGraph, ParsedDependency } from '../types';
import { file, fixture } from './helpers';

const NPM_LOCK = fixture('package-lock', 'v3-monorepo.json');
const NPM_ROOT_PKG = fixture('package-lock', 'root.package.json');
const NPM_WEB_PKG = fixture('package-lock', 'apps-web.package.json');
const V1_LOCK = fixture('package-lock', 'v1-simple.json');
const V1_ROOT_PKG = fixture('package-lock', 'v1-root.package.json');

const BUN_LOCK = fixture('bun-lock', 'bun.lock');
const BUN_ROOT_PKG = fixture('bun-lock', 'root.package.json');
const BUN_WEB_PKG = fixture('bun-lock', 'apps-web.package.json');
const BUN_UI_PKG = fixture('bun-lock', 'packages-ui.package.json');

function find(
	graph: DependencyGraph,
	name: string,
	predicate: (dependency: ParsedDependency) => boolean = () => true
): ParsedDependency | undefined {
	return graph.dependencies.find((d) => d.name === name && predicate(d));
}

/* -------------------------------------------------------------------------- */

describe('detectManager', () => {
	test('detects each lockfile flavour', () => {
		expect(detectManager([file('package-lock.json', '{}')])).toBe('npm');
		expect(detectManager([file('bun.lock', '{}')])).toBe('bun');
		expect(detectManager([file('yarn.lock', '')])).toBe('yarn');
		expect(detectManager([file('pnpm-lock.yaml', '')])).toBe('pnpm');
		expect(detectManager([file('npm-shrinkwrap.json', '{}')])).toBe('npm');
	});

	test('returns null when no lockfile is present', () => {
		expect(detectManager([file('package.json', '{}')])).toBeNull();
		expect(detectManager([])).toBeNull();
	});

	test('prefers the packageManager field when several lockfiles exist', () => {
		const files = [
			file(
				'package.json',
				JSON.stringify({ packageManager: 'bun@1.3.14' })
			),
			file('package-lock.json', '{}'),
			file('bun.lock', '{}'),
			file('yarn.lock', ''),
		];
		expect(detectManager(files)).toBe('bun');
	});

	test('falls back to a fixed priority without a packageManager hint', () => {
		expect(
			detectManager([
				file('bun.lock', '{}'),
				file('package-lock.json', '{}'),
			])
		).toBe('npm');
		expect(
			detectManager([file('yarn.lock', ''), file('pnpm-lock.yaml', '')])
		).toBe('pnpm');
	});

	test('ignores nested lockfiles below the shallowest one', () => {
		const files = [
			file('package.json', '{}'),
			file('bun.lock', '{}'),
			file('examples/demo/package-lock.json', '{}'),
		];
		expect(detectManager(files)).toBe('bun');
	});

	test('ignores vendored lockfiles', () => {
		expect(
			detectManager([file('node_modules/foo/package-lock.json', '{}')])
		).toBeNull();
	});
});

/* -------------------------------------------------------------------------- */

describe('parseManifests', () => {
	test('globs workspaces and resolves catalog: ranges', () => {
		const manifests = parseManifests([
			file('package.json', BUN_ROOT_PKG),
			file('apps/web/package.json', BUN_WEB_PKG),
			file('packages/ui/package.json', BUN_UI_PKG),
		]);

		expect(manifests.root?.path).toBe('');
		expect(manifests.workspaces.map((w) => w.path).sort()).toEqual([
			'',
			'apps/web',
			'packages/ui',
		]);
		expect(manifests.warnings).toEqual([]);

		const react = manifests.byPath.get('apps/web')?.byName.get('react');
		expect(react?.rawRange).toBe('catalog:frontend');
		expect(react?.range).toBe('19.2.8');
		expect(react?.rangeKind).toBe('semver');
		expect(react?.depType).toBe('prod');
	});

	test('classifies workspace: protocol ranges as non-semver', () => {
		const ui = parseManifests([
			file('package.json', BUN_ROOT_PKG),
			file('apps/web/package.json', BUN_WEB_PKG),
		]).byPath.get('apps/web');
		const workspaceDep = ui?.deps.find((d) =>
			d.rawRange.startsWith('workspace:')
		);
		expect(workspaceDep?.rangeKind).toBe('workspace');
	});

	test('records peerDependenciesMeta.optional as peer_optional', () => {
		const manifests = parseManifests([
			file('package.json', NPM_ROOT_PKG),
			file('apps/web/package.json', NPM_WEB_PKG),
		]);
		expect(
			manifests.byPath.get('apps/web')?.byName.get('react-dom')?.depType
		).toBe('peer_optional');
		expect(manifests.byPath.get('')?.byName.get('fsevents')?.depType).toBe(
			'optional'
		);
		expect(
			manifests.byPath.get('')?.byName.get('typescript')?.depType
		).toBe('dev');
	});

	test('warns about manifests outside the workspace patterns but keeps them', () => {
		const manifests = parseManifests([
			file('package.json', NPM_ROOT_PKG),
			file(
				'tools/scripts/package.json',
				JSON.stringify({ name: 'scripts' })
			),
		]);
		expect(manifests.byPath.has('tools/scripts')).toBe(true);
		expect(manifests.warnings.join('\n')).toContain(
			'not matched by the root "workspaces"'
		);
	});

	test('skips vendored manifests', () => {
		const manifests = parseManifests([
			file('package.json', NPM_ROOT_PKG),
			file(
				'node_modules/left-pad/package.json',
				JSON.stringify({ name: 'left-pad' })
			),
		]);
		expect(manifests.workspaces).toHaveLength(1);
	});
});

/* -------------------------------------------------------------------------- */

describe('splitPackageLockKey', () => {
	test('counts node_modules segments as depth and keeps scopes intact', () => {
		expect(splitPackageLockKey('node_modules/foo')).toEqual({
			prefix: '',
			name: 'foo',
			depth: 1,
		});
		expect(splitPackageLockKey('node_modules/@scope/pkg')).toEqual({
			prefix: '',
			name: '@scope/pkg',
			depth: 1,
		});
		expect(
			splitPackageLockKey('node_modules/foo/node_modules/@scope/bar')
		).toEqual({
			prefix: '',
			name: '@scope/bar',
			depth: 2,
		});
		expect(splitPackageLockKey('apps/web/node_modules/foo')).toEqual({
			prefix: 'apps/web',
			name: 'foo',
			depth: 1,
		});
		expect(splitPackageLockKey('apps/web')).toBeNull();
	});
});

describe('package-lock v3', () => {
	const graph = parseLockfile([
		file('package-lock.json', NPM_LOCK),
		file('package.json', NPM_ROOT_PKG),
		file('apps/web/package.json', NPM_WEB_PKG),
	]);

	test('detects the manager and both workspaces', () => {
		expect(graph.manager).toBe('npm');
		expect(graph.workspaces).toEqual(['', 'apps/web']);
		expect(graph.warnings).toEqual([]);
	});

	test('parses every package exactly once and skips the link entry', () => {
		expect(graph.dependencies).toHaveLength(9);
		expect(find(graph, 'web')).toBeUndefined();
	});

	test('treats a scoped package as one package at depth 1', () => {
		const scoped = find(graph, '@scope/util');
		expect(scoped).toMatchObject({
			version: '2.1.0',
			workspace: '',
			isDirect: true,
			depth: 0,
			declaredRange: '^2.0.0',
		});
	});

	test('keeps a nested duplicate of the same package at its own depth', () => {
		const hoisted = find(graph, 'lodash', (d) => d.version === '4.17.20');
		const nested = find(graph, 'lodash', (d) => d.version === '3.10.1');
		expect(hoisted).toMatchObject({
			isDirect: true,
			depth: 0,
			workspace: '',
		});
		expect(nested).toMatchObject({
			isDirect: false,
			depth: 2,
			workspace: '',
		});
	});

	test('attributes hoisted direct deps to the declaring workspace', () => {
		expect(find(graph, 'react')).toMatchObject({
			workspace: 'apps/web',
			isDirect: true,
			depth: 0,
			declaredRange: '^18.2.0',
		});
		expect(find(graph, 'left-pad')).toMatchObject({
			workspace: 'apps/web',
			deprecated: 'use String.prototype.padStart()',
		});
	});

	test('maps dep types from flags and declarations', () => {
		expect(find(graph, 'typescript')?.depType).toBe('dev');
		expect(find(graph, 'fsevents')?.depType).toBe('optional');
		expect(find(graph, 'react-dom')?.depType).toBe('peer_optional');
		expect(find(graph, 'loose-envify')).toMatchObject({
			depType: 'prod',
			depth: 1,
		});
	});

	test('extracts peer requirements', () => {
		expect(find(graph, 'react-dom')?.peerDeps).toEqual({
			react: { range: '^18.3.1', optional: false },
		});
	});

	test('falls back to lockfile-declared deps when no package.json is supplied', () => {
		const result = parsePackageLock(NPM_LOCK, {
			workspaces: [],
			byPath: new Map(),
			warnings: [],
		});
		expect(result.warnings).toEqual([]);
		const scoped = result.dependencies.find(
			(d) => d.name === '@scope/util'
		);
		expect(scoped).toMatchObject({
			isDirect: true,
			declaredRange: '^2.0.0',
		});
	});
});

describe('package-lock v1 fallback', () => {
	const graph = parseLockfile([
		file('package-lock.json', V1_LOCK),
		file('package.json', V1_ROOT_PKG),
	]);

	test('warns that the fallback parser was used', () => {
		expect(graph.warnings.join('\n')).toContain('v1 fallback parser');
	});

	test('derives depth from nesting and direct-ness from the manifest', () => {
		expect(graph.dependencies).toHaveLength(5);
		expect(find(graph, 'lodash')).toMatchObject({
			isDirect: true,
			depth: 0,
		});
		expect(
			find(graph, 'minimist', (d) => d.version === '1.2.5')
		).toMatchObject({
			isDirect: true,
			depth: 0,
			depType: 'dev',
		});
		expect(
			find(graph, 'minimist', (d) => d.version === '1.2.8')
		).toMatchObject({
			isDirect: false,
			depth: 2,
		});
		expect(find(graph, 'fsevents')?.depType).toBe('optional');
	});
});

/* -------------------------------------------------------------------------- */

describe('splitBunLockKey', () => {
	test('treats a scoped name as a single segment', () => {
		expect(splitBunLockKey('react')).toEqual(['react']);
		expect(splitBunLockKey('@babel/core')).toEqual(['@babel/core']);
		expect(splitBunLockKey('@babel/core/semver')).toEqual([
			'@babel/core',
			'semver',
		]);
		expect(
			splitBunLockKey(
				'@tailwindcss/oxide-wasm32-wasi/@napi-rs/wasm-runtime'
			)
		).toEqual(['@tailwindcss/oxide-wasm32-wasi', '@napi-rs/wasm-runtime']);
		expect(splitBunLockKey('a/b/c')).toEqual(['a', 'b', 'c']);
	});
});

describe('splitNameVersion', () => {
	test('splits at the last @ so scoped names survive', () => {
		expect(splitNameVersion('react@19.2.8')).toEqual({
			name: 'react',
			version: '19.2.8',
		});
		expect(splitNameVersion('@base-ui/react@1.7.0')).toEqual({
			name: '@base-ui/react',
			version: '1.7.0',
		});
		expect(splitNameVersion('@workspace/api@workspace:apps/api')).toEqual({
			name: '@workspace/api',
			version: 'workspace:apps/api',
		});
	});
});

describe('bun.lock (real monorepo fixture)', () => {
	const graph = parseLockfile([
		file('bun.lock', BUN_LOCK),
		file('package.json', BUN_ROOT_PKG),
		file('apps/web/package.json', BUN_WEB_PKG),
		file('packages/ui/package.json', BUN_UI_PKG),
	]);

	test('is JSONC — JSON.parse cannot read it', () => {
		expect(() => JSON.parse(BUN_LOCK)).toThrow();
		expect(graph.warnings).toEqual([]);
	});

	test('detects bun and every workspace, including lockfile-only ones', () => {
		expect(graph.manager).toBe('bun');
		expect(graph.workspaces).toContain('');
		expect(graph.workspaces).toContain('apps/api');
		expect(graph.workspaces).toContain(
			'packages/declarative/modules/observability'
		);
		expect(graph.workspaces).toHaveLength(12);
	});

	test('parses the expected dependency counts', () => {
		expect(graph.dependencies).toHaveLength(994);
		expect(graph.dependencies.filter((d) => d.isDirect)).toHaveLength(104);
		expect(graph.dependencies.filter((d) => !d.isDirect)).toHaveLength(890);
	});

	test('infers dev/prod/optional for transitive packages by reachability', () => {
		const byType = graph.dependencies.reduce<Record<string, number>>(
			(acc, dependency) => {
				acc[dependency.depType] = (acc[dependency.depType] ?? 0) + 1;
				return acc;
			},
			{}
		);
		expect(byType.prod).toBe(591);
		expect(byType.dev).toBe(363);
		expect(byType.optional).toBe(40);
	});

	test('attributes a direct dependency to every declaring workspace', () => {
		const react = graph.dependencies.filter((d) => d.name === 'react');
		expect(react.map((d) => d.workspace).sort()).toEqual([
			'apps/web',
			'packages/ui',
		]);
		for (const entry of react) {
			expect(entry).toMatchObject({
				version: '19.2.8',
				isDirect: true,
				depth: 0,
				declaredRange: '19.2.8',
				rawRange: 'catalog:frontend',
			});
		}
	});

	test('resolves catalog: ranges from workspaces that only exist in the lockfile', () => {
		const elysia = find(graph, 'elysia');
		expect(elysia).toMatchObject({
			version: '1.4.29',
			workspace: 'apps/api',
			isDirect: true,
			declaredRange: '1.4.29',
			rawRange: 'catalog:',
		});
	});

	test('extracts peer dependencies including optionalPeers', () => {
		const baseUi = find(graph, '@base-ui/react');
		expect(baseUi?.peerDeps?.react).toEqual({
			range: '^17 || ^18 || ^19',
			optional: false,
		});
		expect(baseUi?.peerDeps?.['@types/react']).toEqual({
			range: '^17 || ^18 || ^19',
			optional: true,
		});
		expect(find(graph, 'elysia')?.peerDeps?.typescript?.optional).toBe(
			true
		);
	});

	test('nests packages by key path, keeping scoped names whole', () => {
		const nestedSemver = find(
			graph,
			'semver',
			(d) => d.version === '6.3.1'
		);
		expect(nestedSemver).toMatchObject({ depth: 2, isDirect: false });

		const wasmRuntime = graph.dependencies.filter(
			(d) => d.name === '@napi-rs/wasm-runtime'
		);
		expect(wasmRuntime.length).toBeGreaterThanOrEqual(1);
		expect(wasmRuntime.some((d) => d.depth === 2)).toBe(true);
	});

	test('never emits workspace: links as installed packages', () => {
		expect(
			graph.dependencies.some((d) => d.version.startsWith('workspace:'))
		).toBe(false);
		expect(
			graph.dependencies.some((d) => d.name.startsWith('@workspace/'))
		).toBe(false);
	});
});

describe('parseLockfile edge cases', () => {
	test('falls back to the packageManager field when no lockfile was fetched', () => {
		const graph = parseLockfile([
			file(
				'package.json',
				JSON.stringify({ packageManager: 'pnpm@9.0.0' })
			),
		]);
		expect(graph.manager).toBe('pnpm');
		expect(graph.warnings.join('\n')).toContain('no lockfile found');
	});

	test('reports unsupported lockfile formats instead of failing', () => {
		const graph = parseLockfile([
			file('package.json', '{}'),
			file('yarn.lock', '# yarn'),
		]);
		expect(graph.manager).toBe('yarn');
		expect(graph.dependencies).toEqual([]);
		expect(graph.warnings.join('\n')).toContain('are not supported yet');
	});

	test('reports binary bun.lockb', () => {
		const graph = parseLockfile([
			file('package.json', '{}'),
			file('bun.lockb', ' bin'),
		]);
		expect(graph.warnings.join('\n')).toContain('binary lockfile');
	});

	test('survives a corrupt lockfile', () => {
		const graph = parseLockfile([
			file('package.json', '{}'),
			file('package-lock.json', '{ not json'),
		]);
		expect(graph.dependencies).toEqual([]);
		expect(graph.warnings.length).toBeGreaterThan(0);
	});
});
