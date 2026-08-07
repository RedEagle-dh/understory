import { describe, expect, test } from 'bun:test';
import {
	applyPypiRangeEdits,
	buildPypiManifestIndex,
	poetryStyleBump,
} from '../services/pypi-manifests';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PEP621_PYPROJECT = [
	'[project]',
	'name = "fixture-app"',
	'version = "0.1.0"',
	'requires-python = ">=3.10"',
	'dependencies = [',
	`    "Requests[security] >=2.19 ; python_version < '3.11'",`,
	"    'django>=4.2,<5',",
	'    "urllib3",',
	']',
	'',
	'[project.optional-dependencies]',
	'docs = ["sphinx>=7.0"]',
	'',
	'[dependency-groups]',
	'dev = ["pytest>=8.0"]',
	'',
].join('\n');

const POETRY_PYPROJECT = [
	'[tool.poetry]',
	'name = "fixture-poetry"',
	'version = "0.1.0"',
	'',
	'[tool.poetry.dependencies]',
	'python = "^3.11"',
	'requests = "^2.28"',
	'flask = { version = "^2.0", extras = ["async"] }',
	'internal-lib = { git = "https://github.com/acme/internal-lib.git" }',
	'',
	'[tool.poetry.group.dev.dependencies]',
	'pytest = "~7.4"',
	'',
	'[tool.poetry.dev-dependencies]',
	'black = "22.3.0"',
	'',
].join('\n');

const REQUIREMENTS_TXT = [
	'# pinned for prod',
	'Requests[security]==2.19.0 ; python_version < "3.11"  # CVE fix pending',
	'-r common.txt',
	'--index-url https://pypi.org/simple',
	'django==4.2.11',
	'flask>=2.0',
	'',
].join('\n');

/* -------------------------------------------------------------------------- */
/* buildPypiManifestIndex                                                     */
/* -------------------------------------------------------------------------- */

describe('buildPypiManifestIndex', () => {
	test('indexes pep621 declarations with raw and effective ranges', () => {
		const index = buildPypiManifestIndex(
			[{ path: 'pyproject.toml', content: PEP621_PYPROJECT }],
			'uv'
		);
		expect(index).not.toBeNull();
		expect(index?.rootPath).toBe('pyproject.toml');

		const requests = index?.declaration('', 'requests');
		expect(requests).toEqual({
			rawRange: "Requests[security] >=2.19 ; python_version < '3.11'",
			effectiveRange: '>=2.19',
			editPath: 'pyproject.toml',
			missingCatalogEntry: false,
			style: 'pep621',
		});

		const bare = index?.declaration('', 'urllib3');
		expect(bare?.rawRange).toBe('urllib3');
		expect(bare?.effectiveRange).toBe('');
	});

	test('normalizes names per PEP 503 on lookup and declaration', () => {
		const index = buildPypiManifestIndex(
			[{ path: 'pyproject.toml', content: PEP621_PYPROJECT }],
			'uv'
		);
		// Declared as `django`, queried with PyPI display casing.
		expect(index?.declaration('', 'Django')?.effectiveRange).toBe(
			'>=4.2,<5'
		);
		// Declared as `Requests`, queried normalized.
		expect(index?.declaration('', 'requests')?.style).toBe('pep621');
	});

	test('finds optional-dependencies and dependency-groups entries', () => {
		const index = buildPypiManifestIndex(
			[{ path: 'pyproject.toml', content: PEP621_PYPROJECT }],
			'uv'
		);
		expect(index?.declaration('', 'sphinx')).toEqual({
			rawRange: 'sphinx>=7.0',
			effectiveRange: '>=7.0',
			editPath: 'pyproject.toml',
			missingCatalogEntry: false,
			style: 'pep621',
		});
		expect(index?.declaration('', 'pytest')?.style).toBe('pep621');
		expect(index?.declaration('', 'pytest')?.effectiveRange).toBe('>=8.0');
	});

	test('indexes poetry string, table and git declarations', () => {
		const index = buildPypiManifestIndex(
			[{ path: 'pyproject.toml', content: POETRY_PYPROJECT }],
			'poetry'
		);

		expect(index?.declaration('', 'requests')).toEqual({
			rawRange: '^2.28',
			effectiveRange: '>=2.28,<3',
			editPath: 'pyproject.toml',
			missingCatalogEntry: false,
			style: 'poetry',
		});

		// Table dep: rawRange is the version value, translated like a string.
		const flask = index?.declaration('', 'flask');
		expect(flask?.rawRange).toBe('^2.0');
		expect(flask?.effectiveRange).toBe('>=2.0,<3');
		expect(flask?.style).toBe('poetry');

		// Git table: nothing to bump; empty effectiveRange drops it upstream.
		const git = index?.declaration('', 'internal-lib');
		expect(git?.effectiveRange).toBe('');
		expect(git?.rawRange).toContain('git');

		// Group and legacy dev sections.
		expect(index?.declaration('', 'pytest')?.rawRange).toBe('~7.4');
		expect(index?.declaration('', 'black')?.effectiveRange).toBe(
			'==22.3.0'
		);
	});

	test('pip manager prefers requirements.txt but still indexes pyproject', () => {
		const index = buildPypiManifestIndex(
			[
				{ path: 'pyproject.toml', content: PEP621_PYPROJECT },
				{ path: 'requirements.txt', content: REQUIREMENTS_TXT },
			],
			'pip'
		);
		expect(index?.rootPath).toBe('requirements.txt');
		expect(index?.manifestPaths()).toEqual([
			'requirements.txt',
			'pyproject.toml',
		]);

		// requirements.txt is searched first and wins for shared names.
		expect(index?.declaration('', 'requests')).toEqual({
			rawRange: 'Requests[security]==2.19.0 ; python_version < "3.11"',
			effectiveRange: '==2.19.0',
			editPath: 'requirements.txt',
			missingCatalogEntry: false,
			style: 'requirements',
		});

		// A name only in the pyproject still resolves, at its own editPath.
		expect(index?.declaration('', 'sphinx')?.editPath).toBe(
			'pyproject.toml'
		);
	});

	test('returns null when no python manifest exists', () => {
		expect(
			buildPypiManifestIndex(
				[{ path: 'package.json', content: '{}' }],
				'uv'
			)
		).toBeNull();
	});

	test('pathAtRoot and pathForWorkspace follow a nested root', () => {
		const index = buildPypiManifestIndex(
			[{ path: 'backend/pyproject.toml', content: PEP621_PYPROJECT }],
			'uv'
		);
		expect(index?.rootPath).toBe('backend/pyproject.toml');
		expect(index?.pathAtRoot('uv.lock')).toBe('backend/uv.lock');
		expect(index?.pathForWorkspace('')).toBe('backend/pyproject.toml');
		// Python graphs are flat: every workspace maps to the root manifest.
		expect(index?.pathForWorkspace('anything')).toBe(
			'backend/pyproject.toml'
		);
	});

	test('skips vendored and virtual-env manifests when picking the root', () => {
		const index = buildPypiManifestIndex(
			[
				{ path: '.venv/lib/pyproject.toml', content: POETRY_PYPROJECT },
				{
					path: 'node_modules/x/pyproject.toml',
					content: POETRY_PYPROJECT,
				},
				{
					path: 'srv/app/pyproject.toml',
					content: PEP621_PYPROJECT,
				},
			],
			'uv'
		);
		expect(index?.rootPath).toBe('srv/app/pyproject.toml');
		expect(index?.manifestPaths()).toEqual(['srv/app/pyproject.toml']);
	});
});

/* -------------------------------------------------------------------------- */
/* applyPypiRangeEdits — pep621                                               */
/* -------------------------------------------------------------------------- */

describe('applyPypiRangeEdits pep621', () => {
	const before = [
		'[project]',
		'name = "fixture-app"',
		'requires-python = ">=3.10"',
		'dependencies = [',
		`    "Requests[security] >=2.19 ; python_version < '3.11'",`,
		"    'django>=4.2,<5',",
		']',
		'',
		'[project.optional-dependencies]',
		'docs = ["requests>=2.0"]',
		'',
	].join('\n');

	test('rewrites specifiers preserving quotes, extras, marker and casing', () => {
		const result = applyPypiRangeEdits(
			before,
			[
				{
					packageName: 'requests',
					newRange: '>=2.31',
					style: 'pep621',
				},
				{ packageName: 'django', newRange: '>=5.0', style: 'pep621' },
			],
			'pyproject'
		);
		expect(result.applied).toEqual(['requests', 'django']);
		// Full-string equality: everything outside the specifiers survives,
		// including the `Requests` casing, `[security]` extras, the marker,
		// the single-quoted django entry, and both occurrences of requests.
		expect(result.content).toBe(
			[
				'[project]',
				'name = "fixture-app"',
				'requires-python = ">=3.10"',
				'dependencies = [',
				`    "Requests[security]>=2.31 ; python_version < '3.11'",`,
				"    'django>=5.0',",
				']',
				'',
				'[project.optional-dependencies]',
				'docs = ["requests>=2.31"]',
				'',
			].join('\n')
		);
	});

	test('a package that cannot be located is absent from applied', () => {
		const result = applyPypiRangeEdits(
			before,
			[{ packageName: 'numpy', newRange: '>=2', style: 'pep621' }],
			'pyproject'
		);
		expect(result.applied).toEqual([]);
		expect(result.content).toBe(before);
	});
});

/* -------------------------------------------------------------------------- */
/* applyPypiRangeEdits — poetry                                               */
/* -------------------------------------------------------------------------- */

describe('applyPypiRangeEdits poetry', () => {
	const before = [
		'[tool.poetry]',
		'name = "fixture-poetry"',
		'',
		'[tool.poetry.dependencies]',
		'python = "^3.11"',
		'requests = "^2.28"  # http client',
		'flask = { version = "^2.0", extras = ["async"] }',
		'"Django" = "^4.2"',
		'internal-lib = { git = "https://github.com/acme/internal-lib.git" }',
		'',
		'[tool.poetry.group.dev.dependencies]',
		'pytest = "~7.4"',
		'',
		'[tool.mytool]',
		'requests = "unrelated"',
		'',
	].join('\n');

	test('rewrites string values, inline-table versions and quoted keys', () => {
		const result = applyPypiRangeEdits(
			before,
			[
				{
					packageName: 'requests',
					newRange: '^2.31.0',
					style: 'poetry',
				},
				{ packageName: 'flask', newRange: '^2.3.0', style: 'poetry' },
				{ packageName: 'django', newRange: '^4.2.11', style: 'poetry' },
				{ packageName: 'pytest', newRange: '~7.4.4', style: 'poetry' },
				{
					// Git table: no version value to replace, so not applied.
					packageName: 'internal-lib',
					newRange: '^1.0',
					style: 'poetry',
				},
			],
			'pyproject'
		);
		expect(result.applied).toEqual([
			'requests',
			'flask',
			'django',
			'pytest',
		]);
		expect(result.content).toBe(
			[
				'[tool.poetry]',
				'name = "fixture-poetry"',
				'',
				'[tool.poetry.dependencies]',
				'python = "^3.11"',
				'requests = "^2.31.0"  # http client',
				'flask = { version = "^2.3.0", extras = ["async"] }',
				'"Django" = "^4.2.11"',
				'internal-lib = { git = "https://github.com/acme/internal-lib.git" }',
				'',
				'[tool.poetry.group.dev.dependencies]',
				'pytest = "~7.4.4"',
				'',
				'[tool.mytool]',
				'requests = "unrelated"',
				'',
			].join('\n')
		);
	});

	test('never touches a same-named key outside tool.poetry sections', () => {
		const result = applyPypiRangeEdits(
			before,
			[{ packageName: 'requests', newRange: '^9.9', style: 'poetry' }],
			'pyproject'
		);
		expect(result.content).toContain('requests = "unrelated"');
	});
});

/* -------------------------------------------------------------------------- */
/* applyPypiRangeEdits — requirements                                         */
/* -------------------------------------------------------------------------- */

describe('applyPypiRangeEdits requirements', () => {
	test('rewrites pins preserving extras, marker, comment and flag lines', () => {
		const result = applyPypiRangeEdits(
			REQUIREMENTS_TXT,
			[
				{
					packageName: 'requests',
					newRange: '==2.32.3',
					style: 'requirements',
				},
				{
					packageName: 'django',
					newRange: '==4.2.16',
					style: 'requirements',
				},
				{
					packageName: 'numpy',
					newRange: '==2.0.0',
					style: 'requirements',
				},
			],
			'requirements'
		);
		expect(result.applied).toEqual(['requests', 'django']);
		expect(result.content).toBe(
			[
				'# pinned for prod',
				'Requests[security]==2.32.3 ; python_version < "3.11"  # CVE fix pending',
				'-r common.txt',
				'--index-url https://pypi.org/simple',
				'django==4.2.16',
				'flask>=2.0',
				'',
			].join('\n')
		);
	});
});

/* -------------------------------------------------------------------------- */
/* poetryStyleBump                                                            */
/* -------------------------------------------------------------------------- */

describe('poetryStyleBump', () => {
	test('preserves caret idiom', () => {
		expect(poetryStyleBump('^2.0', '2.1.4')).toEqual({
			newRange: '^2.1.4',
			changed: true,
		});
	});

	test('preserves tilde idiom', () => {
		expect(poetryStyleBump('~7.4', '7.4.4')).toEqual({
			newRange: '~7.4.4',
			changed: true,
		});
	});

	test('preserves a bare exact pin', () => {
		expect(poetryStyleBump('2.26.0', '2.28.0')).toEqual({
			newRange: '2.28.0',
			changed: true,
		});
	});

	test('preserves an == exact pin', () => {
		expect(poetryStyleBump('==1.2.3', '1.3.0')).toEqual({
			newRange: '==1.3.0',
			changed: true,
		});
	});

	test('wildcards and empty ranges are lockfile-only', () => {
		expect(poetryStyleBump('*', '2.0.0')).toEqual({
			newRange: '*',
			changed: false,
			reason: 'not-semver',
		});
		expect(poetryStyleBump('', '2.0.0').reason).toBe('not-semver');
	});

	test('multi-constraint sets, unions and single comparators stay put', () => {
		expect(poetryStyleBump('>=2,<3', '2.5.0').reason).toBe('not-semver');
		expect(poetryStyleBump('^1 || ^2', '2.0.0').reason).toBe('not-semver');
		expect(poetryStyleBump('>=2.0', '2.5.0').reason).toBe('not-semver');
		expect(poetryStyleBump('~=2.0', '2.5.0').reason).toBe('not-semver');
	});

	test('git, path and url shapes stay put', () => {
		expect(
			poetryStyleBump('git+https://github.com/x/y.git', '1.0.0').reason
		).toBe('not-semver');
		expect(poetryStyleBump('{"git":"https://x"}', '1.0.0').reason).toBe(
			'not-semver'
		);
	});

	test('invalid targets are rejected before anything else', () => {
		expect(poetryStyleBump('^2.0', 'not-a-version')).toEqual({
			newRange: '^2.0',
			changed: false,
			reason: 'invalid-target',
		});
		expect(poetryStyleBump('*', 'garbage').reason).toBe('invalid-target');
	});

	test('a rewrite landing on the written range reports already-target', () => {
		expect(poetryStyleBump('^2.1.4', '2.1.4')).toEqual({
			newRange: '^2.1.4',
			changed: false,
			reason: 'already-target',
		});
		expect(poetryStyleBump('1.2.3', '1.2.3').reason).toBe('already-target');
	});
});
