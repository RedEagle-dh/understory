import { describe, expect, test } from 'bun:test';
import * as engine from '../index';

/**
 * The API app consumes this package through its barrel file only. Pinning the
 * export list here turns an accidental removal into a failing test rather than
 * a build break two packages away.
 */
const PUBLIC_API = [
	// lockfiles
	'parseLockfile',
	'dedupeDependencies',
	'detectManager',
	'findLockfile',
	'findRootManifest',
	'managerFromPackageManagerField',
	'basename',
	'dirname',
	'parseManifests',
	'parseJsonManifest',
	'resolveCatalogRange',
	'workspacesDeclaring',
	'parsePackageLock',
	'splitPackageLockKey',
	'parseBunLock',
	'splitBunLockKey',
	'splitNameVersion',
	// ranges
	'classifyRange',
	'isSemverRange',
	'maxSatisfyingVersion',
	'satisfiesRange',
	'updateKindBetween',
	// registry
	'createNpmClient',
	'createMemoryCache',
	'chunkAdvisoryMap',
	'encodePackageName',
	'RegistryError',
	'DEFAULT_REGISTRY_URL',
	'ABBREVIATED_ACCEPT',
	'BULK_ADVISORY_CHUNK_SIZE',
	// osv
	'createOsvClient',
	'OsvError',
	'DEFAULT_OSV_URL',
	'OSV_BATCH_CHUNK_SIZE',
	'normalizeOsvVuln',
	'osvRangeToClauses',
	'sortOsvEvents',
	'pickCanonicalId',
	// advisories
	'normalizeNpmAdvisory',
	'normalizeNpmBulkResponse',
	'normalizeGhsaId',
	'extractGhsaId',
	'inferFirstPatched',
	'mergeAdvisories',
	'SEVERITIES',
	'SEVERITY_ORDER',
	'compareSeverity',
	'maxSeverity',
	'cvssScoreToBucket',
	'cvssVectorBaseScore',
	'cvssVectorToBucket',
	'parseSeverityLabel',
	// computations
	'computeOutdated',
	'computeFix',
	'checkPeers',
	'planBump',
	// ecosystem port
	'semverVersioning',
	'npmEcosystem',
	'pypiEcosystem',
	'ECOSYSTEMS',
	'ecosystemFor',
	'detectEcosystems',
	// pypi versioning + registry
	'pep440Versioning',
	'normalizePypiName',
	'createPypiClient',
	'DEFAULT_PYPI_URL',
	// pypi parsers
	'parsePypi',
	'parsePep508',
	'parsePyproject',
	'translatePoetryRange',
	'declaredByName',
	'parseUvLock',
	'parsePoetryLock',
	'parseRequirementsTxt',
	'detectPypiManager',
	'isPypiPresent',
	'findPypiFile',
	// osv ecosystem rendering
	'OSV_ECOSYSTEM_NAMES',
	'osvRangeToIntervals',
] as const;

describe('public API surface', () => {
	const exported = new Set(Object.keys(engine));

	test.each([...PUBLIC_API])('exports %s', (name) => {
		expect(exported.has(name)).toBe(true);
	});

	test('exports nothing unexpected', () => {
		expect([...exported].sort()).toEqual([...PUBLIC_API].sort());
	});

	test('end-to-end: parse, audit, fix and bump without touching the network', () => {
		const graph = engine.parseLockfile([
			{
				path: 'package.json',
				content: JSON.stringify({
					name: 'demo',
					dependencies: { lodash: '^4.17.15' },
				}),
			},
			{
				path: 'package-lock.json',
				content: JSON.stringify({
					lockfileVersion: 3,
					packages: {
						'': {
							name: 'demo',
							dependencies: { lodash: '^4.17.15' },
						},
						'node_modules/lodash': { version: '4.17.15' },
					},
				}),
			},
		]);

		expect(graph.dependencies).toHaveLength(1);
		const lodash = graph.dependencies[0];
		expect(lodash).toMatchObject({
			name: 'lodash',
			version: '4.17.15',
			isDirect: true,
		});

		const advisories = engine.mergeAdvisories([
			engine.normalizeNpmBulkResponse({
				lodash: [
					{
						id: 1673,
						url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
						title: 'Command Injection in lodash',
						severity: 'high',
						vulnerable_versions: '<4.17.21',
					},
				],
			}),
		]);
		expect(advisories).toHaveLength(1);
		expect(
			engine.satisfiesRange(
				lodash?.version ?? '',
				advisories[0]?.ranges[0]?.vulnerableRange ?? ''
			)
		).toBe(true);

		const fix = engine.computeFix({
			currentVersion: '4.17.15',
			declaredRange: lodash?.declaredRange,
			allRangesForPackage: advisories.flatMap((a) =>
				a.ranges.map((r) => r.vulnerableRange)
			),
			availableVersions: ['4.17.20', '4.17.21'],
		});
		expect(fix).toMatchObject({
			fixedIn: '4.17.21',
			fixType: 'patch',
			fixWithinRange: true,
		});

		expect(
			engine.planBump({
				declaredRange: lodash?.declaredRange ?? '',
				targetVersion: fix.fixedIn ?? '',
			})
		).toEqual({ newRange: '^4.17.21', changed: true });
	});
});
