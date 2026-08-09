import { describe, expect, test } from 'bun:test';
import {
	isBerryLockfile,
	parseLockfile,
	parsePnpmPackageKey,
	parsePnpmWorkspaceYaml,
	parseYarnDescriptor,
	parseYarnV1,
	stripNpmProtocol,
} from '../lockfiles';
import type { DependencyGraph, ParsedDependency } from '../types';
import { file, fixture } from './helpers';

const PNPM_V9 = fixture('pnpm-lock', 'v9-monorepo.yaml');
const PNPM_WORKSPACE = fixture('pnpm-lock', 'pnpm-workspace.yaml');
const PNPM_ROOT_PKG = fixture('pnpm-lock', 'root.package.json');
const PNPM_WEB_PKG = fixture('pnpm-lock', 'apps-web.package.json');
const PNPM_V6 = fixture('pnpm-lock', 'v6-simple.yaml');
const PNPM_V5 = fixture('pnpm-lock', 'v5-simple.yaml');
const PNPM_V5_PKG = fixture('pnpm-lock', 'v5-root.package.json');

const YARN_V1 = fixture('yarn-lock', 'v1.lock');
const YARN_V1_PKG = fixture('yarn-lock', 'v1-root.package.json');
const YARN_BERRY = fixture('yarn-lock', 'berry.lock');
const YARN_BERRY_PKG = fixture('yarn-lock', 'berry-root.package.json');
const YARN_BERRY_WEB_PKG = fixture('yarn-lock', 'berry-apps-web.package.json');

function find(
	graph: DependencyGraph,
	name: string,
	predicate: (dependency: ParsedDependency) => boolean = () => true
): ParsedDependency | undefined {
	return graph.dependencies.find((d) => d.name === name && predicate(d));
}

/* -------------------------------------------------------------------------- */
/* Key parsing                                                                */
/* -------------------------------------------------------------------------- */

describe('parsePnpmPackageKey', () => {
	test('reads the v6/v9 `name@version` spelling', () => {
		expect(parsePnpmPackageKey('lodash@4.17.21', 'at')).toEqual({
			name: 'lodash',
			version: '4.17.21',
		});
		expect(parsePnpmPackageKey('/lodash@4.17.21', 'at')).toEqual({
			name: 'lodash',
			version: '4.17.21',
		});
		expect(parsePnpmPackageKey('@scope/pkg@1.2.3', 'at')).toEqual({
			name: '@scope/pkg',
			version: '1.2.3',
		});
	});

	test('strips the parenthesised peer context', () => {
		expect(
			parsePnpmPackageKey('react-dom@18.2.0(react@18.2.0)', 'at')
		).toEqual({ name: 'react-dom', version: '18.2.0' });
		expect(
			parsePnpmPackageKey(
				'@storybook/react@7.0.0(react@18.2.0)(typescript@5.4.5)',
				'at'
			)
		).toEqual({ name: '@storybook/react', version: '7.0.0' });
	});

	test('reads the v5 `/name/version` spelling and its underscore peer suffix', () => {
		expect(parsePnpmPackageKey('/lodash/4.17.21', 'slash')).toEqual({
			name: 'lodash',
			version: '4.17.21',
		});
		expect(parsePnpmPackageKey('/@scope/pkg/1.2.3', 'slash')).toEqual({
			name: '@scope/pkg',
			version: '1.2.3',
		});
		expect(
			parsePnpmPackageKey('/react-dom/17.0.2_react@17.0.2', 'slash')
		).toEqual({ name: 'react-dom', version: '17.0.2' });
	});

	test('rejects keys it cannot split', () => {
		expect(parsePnpmPackageKey('', 'at')).toBeNull();
		expect(parsePnpmPackageKey('@scope/pkg', 'at')).toBeNull();
		expect(parsePnpmPackageKey('/lodash', 'slash')).toBeNull();
	});
});

describe('parseYarnDescriptor', () => {
	test('splits at the first `@` past position 0', () => {
		expect(parseYarnDescriptor('lodash@^4.17.15')).toEqual({
			name: 'lodash',
			range: '^4.17.15',
		});
		expect(parseYarnDescriptor('"@babel/core@^7.0.0"')).toEqual({
			name: '@babel/core',
			range: '^7.0.0',
		});
		// An aliased range carries its own `@`; only the first split is right.
		expect(parseYarnDescriptor('foo@npm:bar@^1.0.0')).toEqual({
			name: 'foo',
			range: 'npm:bar@^1.0.0',
		});
	});
});

describe('stripNpmProtocol', () => {
	test('unwraps a plain berry range but keeps a real alias', () => {
		expect(stripNpmProtocol('npm:^4.17.15')).toBe('^4.17.15');
		expect(stripNpmProtocol('npm:lodash@^4.17.15')).toBe(
			'npm:lodash@^4.17.15'
		);
		expect(stripNpmProtocol('workspace:^')).toBe('workspace:^');
	});
});

describe('isBerryLockfile', () => {
	test('keys off the `__metadata` header', () => {
		expect(isBerryLockfile(YARN_BERRY)).toBe(true);
		expect(isBerryLockfile(YARN_V1)).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */
/* pnpm                                                                       */
/* -------------------------------------------------------------------------- */

describe('parseLockfile — pnpm v9 monorepo', () => {
	const graph = parseLockfile([
		file('package.json', PNPM_ROOT_PKG),
		file('apps/web/package.json', PNPM_WEB_PKG),
		file('pnpm-workspace.yaml', PNPM_WORKSPACE),
		file('pnpm-lock.yaml', PNPM_V9),
	]);

	test('detects pnpm and finds both workspaces', () => {
		expect(graph.manager).toBe('pnpm');
		expect(graph.ecosystem).toBe('npm');
		expect(graph.workspaces).toContain('');
		expect(graph.workspaces).toContain('apps/web');
	});

	test('marks importer entries direct, in their own workspace', () => {
		const lodash = find(graph, 'lodash');
		expect(lodash).toMatchObject({
			version: '4.17.21',
			workspace: '',
			depType: 'prod',
			isDirect: true,
			depth: 0,
			declaredRange: '^4.17.15',
		});

		const reactDom = find(graph, 'react-dom');
		expect(reactDom).toMatchObject({
			version: '18.2.0',
			workspace: 'apps/web',
			depType: 'prod',
			isDirect: true,
		});
	});

	test('resolves `catalog:` through pnpm-workspace.yaml', () => {
		expect(find(graph, 'typescript')).toMatchObject({
			version: '5.4.5',
			depType: 'dev',
			isDirect: true,
			rawRange: 'catalog:',
			declaredRange: '^5.4.5',
		});
	});

	test('carries peer requirements from the `packages` section', () => {
		expect(find(graph, 'react-dom')?.peerDeps).toEqual({
			react: { range: '^18.2.0', optional: false },
		});
	});

	test('propagates dev/prod reachability to transitive packages', () => {
		// glob is only reachable through rimraf, a devDependency.
		expect(find(graph, 'glob')).toMatchObject({
			depType: 'dev',
			isDirect: false,
			depth: 2,
		});
		// react is reachable through react-dom, a production dependency.
		expect(find(graph, 'react')).toMatchObject({
			depType: 'prod',
			isDirect: false,
			depth: 2,
		});
		// js-tokens is reachable both ways; production wins, at its shortest depth.
		expect(find(graph, 'js-tokens')).toMatchObject({
			depType: 'prod',
			depth: 3,
		});
	});

	test('keeps the deprecation message', () => {
		expect(find(graph, 'glob')?.deprecated).toContain(
			'no longer supported'
		);
		expect(find(graph, 'rimraf')?.deprecated).toContain(
			'no longer supported'
		);
	});

	test('skips `link:` workspace dependencies', () => {
		expect(find(graph, 'shared')).toBeUndefined();
	});

	test('honours an optionalDependencies importer section', () => {
		expect(find(graph, 'fsevents')).toMatchObject({
			depType: 'optional',
			isDirect: true,
			workspace: 'apps/web',
		});
	});

	test('emits no unresolved-dependency warnings', () => {
		expect(
			graph.warnings.filter((warning) => warning.includes('not found'))
		).toEqual([]);
	});
});

describe('parseLockfile — pnpm v6', () => {
	const graph = parseLockfile([
		file('package.json', PNPM_V5_PKG),
		file('pnpm-lock.yaml', PNPM_V6),
	]);

	test('reads root-level dependency sections when `importers` is absent', () => {
		expect(find(graph, 'lodash')).toMatchObject({
			version: '4.17.21',
			isDirect: true,
			depType: 'prod',
		});
		expect(find(graph, 'rimraf')).toMatchObject({
			version: '3.0.2',
			isDirect: true,
			depType: 'dev',
		});
	});

	test('trusts the explicit `dev` flag on transitive entries', () => {
		expect(find(graph, 'glob')).toMatchObject({
			version: '7.2.3',
			isDirect: false,
			depType: 'dev',
		});
	});
});

describe('parseLockfile — pnpm v5.4', () => {
	const graph = parseLockfile([
		file('package.json', PNPM_V5_PKG),
		file('pnpm-lock.yaml', PNPM_V5),
	]);

	test('reads the `specifiers` sidecar for declared ranges', () => {
		expect(find(graph, 'lodash')).toMatchObject({
			version: '4.17.21',
			isDirect: true,
			rawRange: '^4.17.15',
		});
	});

	test('resolves an importer version carrying a peer suffix', () => {
		expect(find(graph, 'react-dom')).toMatchObject({
			version: '17.0.2',
			isDirect: true,
			depType: 'prod',
		});
	});

	test('reads `/name/version` transitive keys', () => {
		expect(find(graph, 'glob')).toMatchObject({
			version: '7.2.3',
			depType: 'dev',
			isDirect: false,
		});
	});
});

describe('parsePnpmWorkspaceYaml', () => {
	test('reads globs and catalogs', () => {
		const parsed = parsePnpmWorkspaceYaml(PNPM_WORKSPACE);
		expect(parsed.patterns).toEqual(['apps/*', 'packages/*']);
		expect(parsed.catalog).toEqual({ typescript: '^5.4.5' });
	});

	test('degrades to a warning on malformed YAML', () => {
		const parsed = parsePnpmWorkspaceYaml('packages: [\n  - broken');
		expect(parsed.patterns).toEqual([]);
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});
});

/* -------------------------------------------------------------------------- */
/* yarn                                                                       */
/* -------------------------------------------------------------------------- */

describe('parseYarnV1', () => {
	const { entries } = parseYarnV1(YARN_V1);

	test('collapses a multi-descriptor entry into one package', () => {
		const codeFrame = entries.find((e) => e.name === '@babel/code-frame');
		expect(codeFrame?.descriptors.map((d) => d.range)).toEqual([
			'^7.0.0',
			'^7.10.4',
		]);
		expect(codeFrame?.version).toBe('7.12.11');
	});

	test('reads nested dependency blocks', () => {
		const rimraf = entries.find((e) => e.name === 'rimraf');
		expect(rimraf?.deps).toEqual({ glob: '^7.1.3' });
	});

	test('reads peerDependencies and their optional meta', () => {
		const reactDom = entries.find((e) => e.name === 'react-dom');
		expect(reactDom?.peerDeps).toEqual({
			react: { range: '^17.0.2', optional: true },
		});
	});
});

describe('parseLockfile — yarn 1', () => {
	const graph = parseLockfile([
		file('package.json', YARN_V1_PKG),
		file('yarn.lock', YARN_V1),
	]);

	test('detects yarn', () => {
		expect(graph.manager).toBe('yarn');
	});

	test('matches manifest declarations onto lockfile descriptors', () => {
		expect(find(graph, 'lodash')).toMatchObject({
			version: '4.17.21',
			isDirect: true,
			depType: 'prod',
			declaredRange: '^4.17.15',
		});
		expect(find(graph, '@babel/code-frame')).toMatchObject({
			version: '7.12.11',
			isDirect: true,
			depType: 'dev',
		});
	});

	test('infers dev/prod for transitive packages by reachability', () => {
		expect(find(graph, 'glob')).toMatchObject({
			version: '7.2.3',
			isDirect: false,
			depType: 'dev',
			depth: 2,
		});
		expect(find(graph, '@babel/highlight')).toMatchObject({
			isDirect: false,
			depType: 'dev',
		});
		// Reachable from react-dom (prod) and @babel/highlight (dev).
		expect(find(graph, 'js-tokens')).toMatchObject({
			isDirect: false,
			depType: 'prod',
			depth: 2,
		});
	});

	test('emits no unresolved-dependency warnings', () => {
		expect(
			graph.warnings.filter((warning) => warning.includes('not found'))
		).toEqual([]);
	});
});

describe('parseLockfile — yarn berry', () => {
	const graph = parseLockfile([
		file('package.json', YARN_BERRY_PKG),
		file('apps/web/package.json', YARN_BERRY_WEB_PKG),
		file('yarn.lock', YARN_BERRY),
	]);

	test('takes workspaces from the lockfile itself', () => {
		expect(graph.workspaces).toContain('');
		expect(graph.workspaces).toContain('apps/web');
	});

	test('assigns direct dependencies to the declaring workspace', () => {
		expect(find(graph, 'lodash')).toMatchObject({
			version: '4.17.21',
			workspace: '',
			depType: 'prod',
			isDirect: true,
			declaredRange: '^4.17.15',
		});
		expect(find(graph, 'rimraf')).toMatchObject({
			workspace: '',
			depType: 'dev',
			isDirect: true,
		});
		expect(find(graph, 'react-dom')).toMatchObject({
			version: '17.0.2',
			workspace: 'apps/web',
			depType: 'prod',
			isDirect: true,
		});
	});

	test('strips the `npm:` protocol from declared ranges', () => {
		expect(find(graph, 'rimraf')?.declaredRange).toBe('^3.0.2');
	});

	test('never emits a workspace entry as a package', () => {
		expect(find(graph, 'web')).toBeUndefined();
		expect(find(graph, 'yarn-berry')).toBeUndefined();
	});

	test('infers dev/prod for transitive packages by reachability', () => {
		expect(find(graph, 'glob')).toMatchObject({
			depType: 'dev',
			isDirect: false,
			depth: 2,
		});
		expect(find(graph, 'js-tokens')).toMatchObject({
			depType: 'prod',
			isDirect: false,
			depth: 2,
		});
	});
});

/* -------------------------------------------------------------------------- */
/* Robustness                                                                 */
/* -------------------------------------------------------------------------- */

describe('malformed lockfiles', () => {
	test('a broken pnpm-lock.yaml warns instead of throwing', () => {
		const graph = parseLockfile([
			file('package.json', PNPM_ROOT_PKG),
			file('pnpm-lock.yaml', 'importers:\n  .: [oops\n'),
		]);
		expect(graph.dependencies).toEqual([]);
		expect(graph.warnings.some((w) => w.includes('pnpm-lock.yaml'))).toBe(
			true
		);
	});

	test('an empty yarn.lock warns instead of throwing', () => {
		const graph = parseLockfile([
			file('package.json', YARN_V1_PKG),
			file('yarn.lock', '# yarn lockfile v1\n'),
		]);
		expect(graph.dependencies).toEqual([]);
		expect(
			graph.warnings.some((w) => w.includes('no entries were parsed'))
		).toBe(true);
	});
});
