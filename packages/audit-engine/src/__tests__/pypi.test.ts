import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	detectPypiManager,
	findPypiFile,
	isPypiPresent,
	parsePep508,
	parsePoetryLock,
	parsePypi,
	parsePyproject,
	parseRequirementsTxt,
	parseUvLock,
	translatePoetryRange,
} from '../pypi';
import type { DependencyGraph, ParsedDependency } from '../types';
import { file } from './helpers';

function fixtureText(...parts: string[]): string {
	return readFileSync(join(import.meta.dir, 'fixtures', ...parts), 'utf8');
}

const UV_PYPROJECT = fixtureText('pypi-uv', 'pyproject.toml');
const UV_LOCK = fixtureText('pypi-uv', 'uv.lock');
const POETRY_PYPROJECT = fixtureText('pypi-poetry', 'pyproject.toml');
const POETRY_LOCK = fixtureText('pypi-poetry', 'poetry.lock');

function find(
	graph: DependencyGraph,
	name: string
): ParsedDependency | undefined {
	return graph.dependencies.find((dependency) => dependency.name === name);
}

/* -------------------------------------------------------------------------- */

describe('parsePep508', () => {
	test('parses a bare name', () => {
		const req = parsePep508('requests');
		expect(req).toEqual({
			name: 'requests',
			rawName: 'requests',
			extras: [],
			specifier: '',
			marker: undefined,
		});
	});

	test('parses extras and a specifier set', () => {
		const req = parsePep508('requests[security, socks]>=2.0,<3');
		expect(req?.name).toBe('requests');
		expect(req?.extras).toEqual(['security', 'socks']);
		expect(req?.specifier).toBe('>=2.0,<3');
	});

	test('unwraps the parenthesized specifier form', () => {
		expect(parsePep508('requests (>=2.0)')?.specifier).toBe('>=2.0');
	});

	test('splits off environment markers, respecting quotes', () => {
		const req = parsePep508('click==8.1.7; python_version < "3.12"');
		expect(req?.specifier).toBe('==8.1.7');
		expect(req?.marker).toBe('python_version < "3.12"');

		const quoted = parsePep508('foo>=1; sys_platform == "win;32"');
		expect(quoted?.specifier).toBe('>=1');
		expect(quoted?.marker).toBe('sys_platform == "win;32"');
	});

	test('parses direct references', () => {
		const req = parsePep508(
			'pip @ https://github.com/pypa/pip/archive/22.0.2.zip'
		);
		expect(req?.url).toBe('https://github.com/pypa/pip/archive/22.0.2.zip');
		expect(req?.specifier).toBe('');
	});

	test('normalizes the name per PEP 503, keeping the raw one', () => {
		const req = parsePep508('Zope.Interface>=5');
		expect(req?.name).toBe('zope-interface');
		expect(req?.rawName).toBe('Zope.Interface');
	});

	test('returns null for empty or unparseable input', () => {
		expect(parsePep508('')).toBeNull();
		expect(parsePep508('   ')).toBeNull();
		expect(parsePep508('-r other.txt')).toBeNull();
		expect(parsePep508('requests foo')).toBeNull();
		expect(parsePep508('requests[unclosed')).toBeNull();
	});
});

/* -------------------------------------------------------------------------- */

describe('translatePoetryRange', () => {
	test('translates caret ranges', () => {
		expect(translatePoetryRange('^2.31.0')).toEqual({
			specifier: '>=2.31.0,<3',
			rangeKind: 'semver',
		});
		expect(translatePoetryRange('^0.4.2').specifier).toBe('>=0.4.2,<0.5');
		expect(translatePoetryRange('^0.0.3').specifier).toBe('>=0.0.3,<0.0.4');
		expect(translatePoetryRange('^2').specifier).toBe('>=2,<3');
	});

	test('translates tilde ranges', () => {
		expect(translatePoetryRange('~5.3').specifier).toBe('>=5.3,<5.4');
		expect(translatePoetryRange('~1.2.3').specifier).toBe('>=1.2.3,<1.3');
		expect(translatePoetryRange('~1').specifier).toBe('>=1,<2');
	});

	test('passes PEP 440 specifier sets through', () => {
		expect(translatePoetryRange('>=2.0,<3')).toEqual({
			specifier: '>=2.0,<3',
			rangeKind: 'semver',
		});
	});

	test('pins bare versions and recognizes wildcards', () => {
		expect(translatePoetryRange('2.26.0').specifier).toBe('==2.26.0');
		expect(translatePoetryRange('*').rangeKind).toBe('wildcard');
		expect(translatePoetryRange('^1 || ^2').rangeKind).toBe('unknown');
	});
});

/* -------------------------------------------------------------------------- */

describe('parsePyproject', () => {
	test('reads PEP 621 dependencies, extras and dependency groups', () => {
		const result = parsePyproject(UV_PYPROJECT);
		expect(result.name).toBe('acme-api');
		expect(result.usesPoetry).toBe(false);
		expect(result.warnings).toEqual([]);

		const byName = new Map(result.declared.map((d) => [d.name, d]));
		expect(byName.get('fastapi')).toMatchObject({
			depType: 'prod',
			specifier: '>=0.110,<1',
			rangeKind: 'semver',
		});
		expect(byName.get('django')).toMatchObject({
			rawRange: 'Django>=4.2',
			specifier: '>=4.2',
		});
		expect(byName.get('click')?.depType).toBe('optional');
		expect(byName.get('pytest')?.depType).toBe('dev');
	});

	test('reads poetry sections, translating short forms and tables', () => {
		const result = parsePyproject(POETRY_PYPROJECT);
		expect(result.name).toBe('acme-worker');
		expect(result.usesPoetry).toBe(true);

		const byName = new Map(result.declared.map((d) => [d.name, d]));
		// The interpreter constraint is not a package.
		expect(byName.has('python')).toBe(false);
		expect(byName.get('requests')).toMatchObject({
			depType: 'prod',
			specifier: '>=2.31.0,<3',
			rangeKind: 'semver',
		});
		expect(byName.get('celery')).toMatchObject({
			depType: 'prod',
			specifier: '>=5.3,<5.4',
		});
		expect(byName.get('internal-lib')).toMatchObject({
			rangeKind: 'git',
			specifier: '',
		});
		expect(byName.get('pytest')?.depType).toBe('dev');
		expect(byName.get('black')).toMatchObject({
			depType: 'dev',
			rangeKind: 'wildcard',
		});
	});

	test('returns empty with a warning on malformed TOML', () => {
		const result = parsePyproject('this is not = [ toml');
		expect(result.declared).toEqual([]);
		expect(result.usesPoetry).toBe(false);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toStartWith('pyproject.toml:');
	});
});

/* -------------------------------------------------------------------------- */

describe('parseUvLock', () => {
	const declared = parsePyproject(UV_PYPROJECT).declared;

	test('splits direct and transitive dependencies via declarations', () => {
		const result = parseUvLock(UV_LOCK, declared);
		expect(result.warnings).toEqual([]);
		expect(result.dependencies).toHaveLength(8);

		const byName = new Map(result.dependencies.map((d) => [d.name, d]));
		// The virtual root package is not a dependency.
		expect(byName.has('acme-api')).toBe(false);

		expect(byName.get('fastapi')).toMatchObject({
			version: '0.110.3',
			isDirect: true,
			depth: 0,
			depType: 'prod',
			declaredRange: '>=0.110,<1',
		});
		expect(byName.get('click')?.depType).toBe('optional');
		expect(byName.get('pytest')?.depType).toBe('dev');
		expect(byName.get('starlette')).toMatchObject({
			version: '0.37.2',
			isDirect: false,
			depth: 1,
			depType: 'prod',
		});
	});

	test('matches declarations by normalized name (Django → django)', () => {
		const result = parseUvLock(UV_LOCK, declared);
		const django = result.dependencies.find((d) => d.name === 'django');
		expect(django).toMatchObject({
			isDirect: true,
			rawRange: 'Django>=4.2',
			version: '4.2.11',
		});
	});

	test('warns when several workspace members are flattened', () => {
		const lock = [
			'version = 1',
			'[[package]]',
			'name = "app-a"',
			'version = "0.1.0"',
			'source = { editable = "packages/a" }',
			'[[package]]',
			'name = "app-b"',
			'version = "0.1.0"',
			'source = { virtual = "packages/b" }',
			'[[package]]',
			'name = "requests"',
			'version = "2.31.0"',
			'source = { registry = "https://pypi.org/simple" }',
		].join('\n');
		const result = parseUvLock(lock, []);
		expect(result.dependencies).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('flattened');
	});

	test('returns empty with a warning on malformed TOML', () => {
		const result = parseUvLock('version = = 1', []);
		expect(result.dependencies).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toStartWith('uv.lock:');
	});
});

/* -------------------------------------------------------------------------- */

describe('parsePoetryLock', () => {
	const declared = parsePyproject(POETRY_PYPROJECT).declared;

	test('splits direct and transitive dependencies via declarations', () => {
		const result = parsePoetryLock(POETRY_LOCK, declared);
		expect(result.warnings).toEqual([]);
		expect(result.dependencies).toHaveLength(6);

		const byName = new Map(result.dependencies.map((d) => [d.name, d]));
		expect(byName.get('requests')).toMatchObject({
			version: '2.31.0',
			isDirect: true,
			depth: 0,
			depType: 'prod',
			declaredRange: '>=2.31.0,<3',
		});
		expect(byName.get('celery')).toMatchObject({
			isDirect: true,
			depType: 'prod',
		});
		expect(byName.get('urllib3')).toMatchObject({
			isDirect: false,
			depth: 1,
			depType: 'prod',
		});
	});

	test('maps groups and the legacy category field onto dep types', () => {
		const result = parsePoetryLock(POETRY_LOCK, declared);
		const byName = new Map(result.dependencies.map((d) => [d.name, d]));
		// Direct dev declarations win over lockfile metadata.
		expect(byName.get('pytest')?.depType).toBe('dev');
		expect(byName.get('black')).toMatchObject({
			isDirect: true,
			depType: 'dev',
		});
		// A transitive `optional = true` package installs only via an extra.
		expect(byName.get('redis')).toMatchObject({
			isDirect: false,
			depType: 'optional',
		});
	});

	test('treats transitive dev-only groups and categories as dev', () => {
		const lock = [
			'[[package]]',
			'name = "mypy"',
			'version = "1.10.0"',
			'optional = false',
			'groups = ["dev"]',
			'[[package]]',
			'name = "tomlkit"',
			'version = "0.12.5"',
			'optional = false',
			'category = "dev"',
		].join('\n');
		const result = parsePoetryLock(lock, []);
		for (const dependency of result.dependencies) {
			expect(dependency.depType).toBe('dev');
			expect(dependency.isDirect).toBe(false);
		}
	});

	test('returns empty with a warning on malformed TOML', () => {
		const result = parsePoetryLock('[[package]\nname = "x"', []);
		expect(result.dependencies).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toStartWith('poetry.lock:');
	});
});

/* -------------------------------------------------------------------------- */

describe('parseRequirementsTxt', () => {
	test('pins, declarations, comments and continuations', () => {
		const content = [
			'# a full-line comment',
			'requests==2.31.0',
			'flask>=2.0  # trailing comment',
			'click==8.1.7; python_version < "3.12"',
			'numpy==1.26.*',
			'pandas \\',
			'==2.2.2',
			'',
		].join('\n');
		const result = parseRequirementsTxt(content);

		expect(result.declared.map((d) => d.name)).toEqual([
			'requests',
			'flask',
			'click',
			'numpy',
			'pandas',
		]);
		expect(result.pinned.map((d) => [d.name, d.version])).toEqual([
			['requests', '2.31.0'],
			['click', '8.1.7'],
			['pandas', '2.2.2'],
		]);
		expect(result.pinned[0]).toMatchObject({
			workspace: '',
			depType: 'prod',
			isDirect: true,
			depth: 0,
		});
		// flask (range) and numpy (`.*` wildcard pin) have no locked version.
		expect(
			result.warnings.filter((w) => w.includes('not pinned'))
		).toHaveLength(1);
		expect(result.warnings.find((w) => w.includes('not pinned'))).toContain(
			'2 requirement(s)'
		);
	});

	test('skips option lines with one warning per flag kind', () => {
		const content = [
			'-r base.txt',
			'-r other.txt',
			'--index-url https://pypi.example.com/simple',
			'-e .',
			'-c constraints.txt',
			'requests==2.31.0',
		].join('\n');
		const result = parseRequirementsTxt(content);
		expect(result.pinned).toHaveLength(1);
		const flagWarnings = result.warnings.filter((w) =>
			w.includes('not supported')
		);
		expect(flagWarnings).toHaveLength(4);
		expect(flagWarnings[0]).toContain('"-r"');
	});

	test('handles an empty file', () => {
		const result = parseRequirementsTxt('');
		expect(result.declared).toEqual([]);
		expect(result.pinned).toEqual([]);
		expect(result.warnings).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */

describe('detectPypiManager', () => {
	test('detects each lockfile flavour', () => {
		expect(detectPypiManager([file('uv.lock', '')])).toBe('uv');
		expect(detectPypiManager([file('poetry.lock', '')])).toBe('poetry');
		expect(detectPypiManager([file('requirements.txt', '')])).toBe('pip');
	});

	test('prefers uv > poetry > pip when several tie', () => {
		expect(
			detectPypiManager([
				file('requirements.txt', ''),
				file('poetry.lock', ''),
				file('uv.lock', ''),
			])
		).toBe('uv');
		expect(
			detectPypiManager([
				file('requirements.txt', ''),
				file('poetry.lock', ''),
			])
		).toBe('poetry');
	});

	test('the shallowest lockfile wins over deeper ones', () => {
		expect(
			detectPypiManager([
				file('requirements.txt', ''),
				file('services/api/uv.lock', ''),
			])
		).toBe('pip');
	});

	test('sniffs pyproject.toml tool sections without a lockfile', () => {
		expect(detectPypiManager([file('pyproject.toml', '[tool.uv]\n')])).toBe(
			'uv'
		);
		expect(
			detectPypiManager([
				file('pyproject.toml', '[tool.poetry]\nname = "x"\n'),
			])
		).toBe('poetry');
		expect(
			detectPypiManager([
				file('pyproject.toml', '[project]\nname = "x"\n'),
			])
		).toBe('pip');
	});

	test('ignores vendored paths and returns null without Python files', () => {
		expect(
			detectPypiManager([
				file(
					'.venv/lib/python3.11/site-packages/foo/requirements.txt',
					''
				),
				file('node_modules/pkg/pyproject.toml', ''),
			])
		).toBeNull();
		expect(detectPypiManager([])).toBeNull();
	});
});

describe('isPypiPresent / findPypiFile', () => {
	test('isPypiPresent recognizes any Python manifest or lockfile', () => {
		expect(isPypiPresent([file('pyproject.toml', '')])).toBe(true);
		expect(isPypiPresent([file('uv.lock', '')])).toBe(true);
		expect(isPypiPresent([file('package.json', '{}')])).toBe(false);
		expect(
			isPypiPresent([file('.venv/site-packages/pyproject.toml', '')])
		).toBe(false);
	});

	test('findPypiFile picks the shallowest match', () => {
		const files = [
			file('examples/demo/pyproject.toml', 'nested'),
			file('pyproject.toml', 'root'),
		];
		expect(findPypiFile(files, 'pyproject.toml')?.content).toBe('root');
	});
});

/* -------------------------------------------------------------------------- */

describe('parsePypi', () => {
	test('parses the uv fixture end-to-end', () => {
		const graph = parsePypi([
			file('pyproject.toml', UV_PYPROJECT),
			file('uv.lock', UV_LOCK),
		]);
		expect(graph.ecosystem).toBe('pypi');
		expect(graph.manager).toBe('uv');
		expect(graph.workspaces).toEqual(['']);
		expect(graph.warnings).toEqual([]);
		expect(graph.dependencies).toHaveLength(8);

		expect(find(graph, 'django')).toMatchObject({
			version: '4.2.11',
			isDirect: true,
			depType: 'prod',
			rawRange: 'Django>=4.2',
			workspace: '',
		});
		expect(find(graph, 'starlette')).toMatchObject({
			version: '0.37.2',
			isDirect: false,
			depth: 1,
			depType: 'prod',
		});
	});

	test('parses the poetry fixture end-to-end', () => {
		const graph = parsePypi([
			file('pyproject.toml', POETRY_PYPROJECT),
			file('poetry.lock', POETRY_LOCK),
		]);
		expect(graph.manager).toBe('poetry');
		expect(graph.dependencies).toHaveLength(6);
		expect(find(graph, 'celery')).toMatchObject({
			version: '5.3.6',
			isDirect: true,
		});
		expect(find(graph, 'redis')?.depType).toBe('optional');
		// The git dependency is absent from the lockfile fixture, but git
		// ranges are exempt from the missing-in-lockfile warning.
		expect(
			graph.warnings.filter((w) => w.includes('internal-lib'))
		).toEqual([]);
	});

	test('warns about evaluable declarations missing from the lockfile', () => {
		const pyproject = [
			'[project]',
			'name = "x"',
			'dependencies = ["missingpkg>=1", "present==1.0.0"]',
		].join('\n');
		const lock = [
			'version = 1',
			'[[package]]',
			'name = "x"',
			'version = "0.0.0"',
			'source = { virtual = "." }',
			'[[package]]',
			'name = "present"',
			'version = "1.0.0"',
			'source = { registry = "https://pypi.org/simple" }',
		].join('\n');
		const graph = parsePypi([
			file('pyproject.toml', pyproject),
			file('uv.lock', lock),
		]);
		expect(graph.dependencies.map((d) => d.name)).toEqual(['present']);
		expect(graph.warnings).toEqual([
			'missingpkg is declared but not present in the lockfile',
		]);
	});

	test('uses requirements.txt pins for the pip manager', () => {
		const graph = parsePypi([
			file('requirements.txt', 'requests==2.31.0\nflask>=2.0\n'),
		]);
		expect(graph.manager).toBe('pip');
		expect(graph.dependencies).toHaveLength(1);
		expect(find(graph, 'requests')?.version).toBe('2.31.0');
		expect(graph.warnings.some((w) => w.includes('not pinned'))).toBe(true);
	});

	test('returns an empty graph with warnings when nothing is resolvable', () => {
		const withoutLock = parsePypi([file('pyproject.toml', UV_PYPROJECT)]);
		expect(withoutLock.manager).toBe('uv');
		expect(withoutLock.dependencies).toEqual([]);
		expect(withoutLock.warnings.some((w) => w.includes('uv.lock'))).toBe(
			true
		);

		const empty = parsePypi([]);
		expect(empty.ecosystem).toBe('pypi');
		expect(empty.dependencies).toEqual([]);
		expect(empty.warnings.length).toBeGreaterThan(0);
	});

	test('surfaces malformed TOML as warnings, never throws', () => {
		const graph = parsePypi([
			file('pyproject.toml', 'not toml = = ='),
			file('uv.lock', 'also not toml = = ='),
		]);
		expect(graph.dependencies).toEqual([]);
		expect(
			graph.warnings.some((w) => w.startsWith('pyproject.toml:'))
		).toBe(true);
		expect(graph.warnings.some((w) => w.startsWith('uv.lock:'))).toBe(true);
	});
});
