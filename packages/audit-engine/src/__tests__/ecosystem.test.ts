import { describe, expect, test } from 'bun:test';
import {
	detectEcosystems,
	ECOSYSTEMS,
	ecosystemFor,
	npmEcosystem,
	pypiEcosystem,
} from '../ecosystem';
import type { Ecosystem, FileEntry } from '../types';
import { semverVersioning } from '../versioning';

const MANIFEST: FileEntry = {
	path: 'package.json',
	content: JSON.stringify({ name: 'demo', version: '1.0.0' }),
};

describe('ecosystem registry', () => {
	test('npm is registered and resolvable by id', () => {
		expect(ECOSYSTEMS).toContain(npmEcosystem);
		expect(ecosystemFor('npm')).toBe(npmEcosystem);
	});

	test('pypi is registered and resolvable by id', () => {
		expect(ECOSYSTEMS).toContain(pypiEcosystem);
		expect(ecosystemFor('pypi')).toBe(pypiEcosystem);
	});

	test('unknown ids throw', () => {
		expect(() => ecosystemFor('cargo' as Ecosystem)).toThrow(
			'unknown ecosystem'
		);
	});

	test('detectEcosystems keys off manifests or lockfiles', () => {
		expect(detectEcosystems([MANIFEST])).toEqual([npmEcosystem]);
		expect(
			detectEcosystems([{ path: 'package-lock.json', content: '{}' }])
		).toEqual([npmEcosystem]);
		expect(
			detectEcosystems([{ path: 'pyproject.toml', content: '' }])
		).toEqual([pypiEcosystem]);
		expect(detectEcosystems([{ path: 'README.md', content: '' }])).toEqual(
			[]
		);
	});

	test('npm wins registry order in polyglot repositories', () => {
		const ports = detectEcosystems([
			MANIFEST,
			{ path: 'pyproject.toml', content: '' },
		]);
		expect(ports.map((port) => port.ecosystem)).toEqual(['npm', 'pypi']);
	});

	test('pypi planBump preserves the declared idiom', () => {
		expect(
			pypiEcosystem.planBump({
				declaredRange: '==1.2.3',
				targetVersion: '1.2.4',
			})
		).toEqual({ newRange: '==1.2.4', changed: true });
		expect(
			pypiEcosystem.planBump({
				declaredRange: '==1.2.*',
				targetVersion: '2.32.3',
			})
		).toEqual({ newRange: '==2.32.*', changed: true });
		expect(
			pypiEcosystem.planBump({
				declaredRange: '~=1.4.2',
				targetVersion: '2.1.0',
			})
		).toEqual({ newRange: '~=2.1.0', changed: true });
		expect(
			pypiEcosystem.planBump({
				declaredRange: '>=1.2,<2',
				targetVersion: '2.1.0',
			})
		).toEqual({ newRange: '>=2.1.0,<3', changed: true });
		expect(
			pypiEcosystem.planBump({
				declaredRange: '>=1!1.0,<1!2',
				targetVersion: '1!2.1.0',
			})
		).toEqual({ newRange: '>=1!2.1.0,<1!3', changed: true });
	});

	test('pypi planBump leaves wildcards and non-ranges alone', () => {
		expect(
			pypiEcosystem.planBump({
				declaredRange: '',
				targetVersion: '2.0.0',
			})
		).toEqual({ newRange: '', changed: false, reason: 'not-semver' });
		expect(
			pypiEcosystem.planBump({
				declaredRange: 'git+https://github.com/a/b',
				targetVersion: '2.0.0',
			})
		).toEqual({
			newRange: 'git+https://github.com/a/b',
			changed: false,
			reason: 'not-semver',
		});
		expect(
			pypiEcosystem.planBump({
				declaredRange: '==2.0.0',
				targetVersion: 'not-a-version',
			})
		).toEqual({
			newRange: '==2.0.0',
			changed: false,
			reason: 'invalid-target',
		});
		expect(
			pypiEcosystem.planBump({
				declaredRange: '==2.0.0',
				targetVersion: '2.0.0',
			})
		).toEqual({
			newRange: '==2.0.0',
			changed: false,
			reason: 'already-target',
		});
	});

	test('parse stamps the graph with the ecosystem', () => {
		const graph = npmEcosystem.parse([MANIFEST]);
		expect(graph.ecosystem).toBe('npm');
		expect(graph.manager).toBe('npm');
	});
});

describe('semverVersioning', () => {
	test('vulnerability matching includes prereleases', () => {
		expect(semverVersioning.satisfies('1.2.0-rc.1', '<1.2.0')).toBe(true);
	});

	test('upgrade targets exclude prereleases', () => {
		expect(
			semverVersioning.maxSatisfying(
				['1.1.0', '1.2.0-rc.1', '1.1.5'],
				'^1.0.0'
			)
		).toBe('1.1.5');
	});

	test('prerelease → release on the same tuple reads as patch', () => {
		expect(
			semverVersioning.updateKindBetween('2.0.0-beta.1', '2.0.0')
		).toBe('patch');
	});

	test('compare and validity follow loose semver', () => {
		expect(semverVersioning.compare('1.10.0', '1.9.0')).toBeGreaterThan(0);
		expect(semverVersioning.isValidVersion('v1.2.3')).toBe(true);
		expect(semverVersioning.isValidVersion('not-a-version')).toBe(false);
		expect(semverVersioning.isValidRange('workspace:*')).toBe(false);
		expect(semverVersioning.isPrerelease('1.0.0-alpha')).toBe(true);
		expect(semverVersioning.isPrerelease('1.0.0')).toBe(false);
	});

	test('npm names are already canonical', () => {
		expect(semverVersioning.normalizeName('@Scope/Pkg')).toBe('@Scope/Pkg');
	});

	test('classifyRange delegates to the npm classifier', () => {
		expect(semverVersioning.classifyRange('^1.2.3')).toBe('semver');
		expect(semverVersioning.classifyRange('workspace:^')).toBe('workspace');
	});
});
