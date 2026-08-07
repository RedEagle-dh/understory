import { describe, expect, test } from 'bun:test';
import { normalizePypiName, pep440Versioning as v } from '../pep440';

describe('normalizePypiName', () => {
	test('folds case and runs of -_. into single dashes (PEP 503)', () => {
		expect(normalizePypiName('Django')).toBe('django');
		expect(normalizePypiName('zope.interface')).toBe('zope-interface');
		expect(normalizePypiName('foo__bar.-baz')).toBe('foo-bar-baz');
	});
});

describe('pep440 versions', () => {
	test('validity', () => {
		expect(v.isValidVersion('1.0.0')).toBe(true);
		expect(v.isValidVersion('1!2.0.post1.dev3')).toBe(true);
		expect(v.isValidVersion('2021.4')).toBe(true);
		expect(v.isValidVersion('not-a-version')).toBe(false);
	});

	test('ordering: dev < pre < final < post, epoch dominates', () => {
		expect(v.compare('2.0.0.dev1', '2.0.0rc1')).toBeLessThan(0);
		expect(v.compare('2.0.0rc1', '2.0.0')).toBeLessThan(0);
		expect(v.compare('2.0.0.post1', '2.0.0')).toBeGreaterThan(0);
		expect(v.compare('1!1.0', '2.0')).toBeGreaterThan(0);
		expect(v.compare('1.10', '1.9')).toBeGreaterThan(0);
	});

	test('prerelease detection includes dev releases', () => {
		expect(v.isPrerelease('1.0.0rc1')).toBe(true);
		expect(v.isPrerelease('1.0.0.dev2')).toBe(true);
		expect(v.isPrerelease('1.0.0.post1')).toBe(false);
		expect(v.isPrerelease('1.0.0')).toBe(false);
	});

	test('updateKindBetween uses the release tuple; epoch jump is major', () => {
		expect(v.updateKindBetween('1.2.3', '1.2.4')).toBe('patch');
		expect(v.updateKindBetween('1.2.3', '1.3.0')).toBe('minor');
		expect(v.updateKindBetween('1.2.3', '2.0.0')).toBe('major');
		expect(v.updateKindBetween('2.0.0', '1!1.0.0')).toBe('major');
		expect(v.updateKindBetween('2.0.0rc1', '2.0.0')).toBe('patch');
		expect(v.updateKindBetween('2.0.0', '2.0.0')).toBe('none');
		expect(v.updateKindBetween('2.1', '2.0')).toBe('none');
	});
});

describe('pep440 ranges', () => {
	test('range validity', () => {
		expect(v.isValidRange('>=2.0, <3')).toBe(true);
		expect(v.isValidRange('~=1.4.2')).toBe(true);
		expect(v.isValidRange('==1.0.*')).toBe(true);
		expect(v.isValidRange('^1.2.3')).toBe(false);
		expect(v.isValidRange('>=1.0.0 <2.0.0')).toBe(false);
	});

	test('satisfies evaluates comma-separated clause sets', () => {
		expect(v.satisfies('2.5', '>=2.0, <3')).toBe(true);
		expect(v.satisfies('3.0', '>=2.0, <3')).toBe(false);
		expect(v.satisfies('1.4.9', '~=1.4.2')).toBe(true);
		expect(v.satisfies('1.5.0', '~=1.4.2')).toBe(false);
		expect(v.satisfies('1.0.7', '==1.0.*')).toBe(true);
		expect(v.satisfies('1.1.0', '==1.0.*')).toBe(false);
		expect(v.satisfies('1.1.0', '!=1.0.*')).toBe(true);
		expect(v.satisfies('1.2.3', '==1.2.3')).toBe(true);
		expect(v.satisfies('1.2.3', '===1.2.3')).toBe(true);
	});

	test('interval matching includes prereleases of the boundary', () => {
		// pip's specifier rules would exclude 1.2.0rc1 from <1.2.0; advisory
		// intervals must not.
		expect(v.satisfies('1.2.0rc1', '<1.2.0')).toBe(true);
		expect(v.satisfies('1.2.0rc1', '>=0, <1.2.0')).toBe(true);
		expect(v.satisfies('1.2.0', '<1.2.0')).toBe(false);
	});

	test('epoch-aware wildcard and prefix matching', () => {
		expect(v.satisfies('1!1.0.2', '==1!1.0.*')).toBe(true);
		expect(v.satisfies('1.0.2', '==1!1.0.*')).toBe(false);
	});

	test('maxSatisfying excludes prereleases and respects the range', () => {
		expect(v.maxSatisfying(['1.1.0', '1.2.0rc1', '1.1.5'], '>=1.0')).toBe(
			'1.1.5'
		);
		expect(v.maxSatisfying(['1.1.0', '2.0.0'], '<2.0')).toBe('1.1.0');
		expect(v.maxSatisfying(['0.9'], '>=1.0')).toBeUndefined();
	});

	test('empty specifier means any (released) version', () => {
		expect(v.satisfies('1.0.0', '')).toBe(true);
		expect(v.maxSatisfying(['1.0.0', '2.0.0'], '')).toBe('2.0.0');
	});

	test('classifyRange maps pypi declared ranges onto RangeKind', () => {
		expect(v.classifyRange('>=2.0,<3')).toBe('semver');
		expect(v.classifyRange('')).toBe('wildcard');
		expect(v.classifyRange('*')).toBe('wildcard');
		expect(v.classifyRange('git+https://github.com/a/b')).toBe('git');
		expect(v.classifyRange('https://example.com/pkg.whl')).toBe('url');
		expect(v.classifyRange('file:./local')).toBe('file');
		expect(v.classifyRange('^1.2.3')).toBe('unknown');
	});

	test('garbage input never matches', () => {
		expect(v.satisfies('garbage', '>=1.0')).toBe(false);
		expect(v.satisfies('1.0.0', 'garbage')).toBe(false);
	});
});
