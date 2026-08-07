import { describe, expect, test } from 'bun:test';
import { mergeAdvisories } from '../advisories/merge';
import {
	extractGhsaId,
	inferFirstPatched,
	normalizeNpmBulkResponse,
} from '../advisories/normalize-npm';
import {
	compareSeverity,
	cvssScoreToBucket,
	cvssVectorBaseScore,
	maxSeverity,
	parseSeverityLabel,
	SEVERITY_ORDER,
} from '../advisories/severity';
import {
	normalizeOsvVuln,
	osvRangeToClauses,
	pickCanonicalId,
	sortOsvEvents,
} from '../osv/normalize';
import type { NpmBulkAdvisoryResponse, OsvVuln } from '../types';
import { fixtureJson } from './helpers';

const NPM_LODASH = fixtureJson<NpmBulkAdvisoryResponse>(
	'npm-bulk',
	'lodash.json'
);
const NPM_MINIMIST = fixtureJson<NpmBulkAdvisoryResponse>(
	'npm-bulk',
	'minimist.json'
);
const OSV_LODASH_CMD = fixtureJson<OsvVuln>('osv', 'GHSA-35jh-r3h4-6jhm.json');
const OSV_LODASH_PROTO = fixtureJson<OsvVuln>(
	'osv',
	'GHSA-p6mc-m468-83gg.json'
);
const OSV_MINIMIST = fixtureJson<OsvVuln>('osv', 'GHSA-vh95-rmgr-6w4m.json');

/* -------------------------------------------------------------------------- */

describe('severity helpers', () => {
	test('orders severities', () => {
		expect(SEVERITY_ORDER.critical).toBeGreaterThan(SEVERITY_ORDER.high);
		expect(compareSeverity('low', 'critical')).toBeLessThan(0);
		expect(compareSeverity('high', 'high')).toBe(0);
		expect(maxSeverity(['low', 'high', 'moderate'])).toBe('high');
		expect(maxSeverity([])).toBe('low');
	});

	test('buckets CVSS scores at the npm/GitHub boundaries', () => {
		expect(cvssScoreToBucket(0)).toBe('low');
		expect(cvssScoreToBucket(3.9)).toBe('low');
		expect(cvssScoreToBucket(4)).toBe('moderate');
		expect(cvssScoreToBucket(6.9)).toBe('moderate');
		expect(cvssScoreToBucket(7)).toBe('high');
		expect(cvssScoreToBucket(8.9)).toBe('high');
		expect(cvssScoreToBucket(9)).toBe('critical');
		expect(cvssScoreToBucket(10)).toBe('critical');
	});

	test('parses textual severity labels', () => {
		expect(parseSeverityLabel('HIGH')).toBe('high');
		expect(parseSeverityLabel('Medium')).toBe('moderate');
		expect(parseSeverityLabel('MODERATE')).toBe('moderate');
		expect(parseSeverityLabel('CRITICAL')).toBe('critical');
		expect(parseSeverityLabel('nonsense')).toBeNull();
		expect(parseSeverityLabel(undefined)).toBeNull();
	});

	test('computes CVSS v3.1 base scores', () => {
		expect(
			cvssVectorBaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')
		).toBe(9.8);
		expect(
			cvssVectorBaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H')
		).toBe(10);
		expect(
			cvssVectorBaseScore('CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H')
		).toBe(7.2);
		expect(
			cvssVectorBaseScore('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:L')
		).toBe(5.6);
		expect(
			cvssVectorBaseScore('CVSS:3.0/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:L/A:L')
		).toBe(3.8);
	});

	test('returns null for unsupported CVSS versions and garbage', () => {
		expect(
			cvssVectorBaseScore(
				'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
			)
		).toBeNull();
		expect(cvssVectorBaseScore('CVSS:3.1/AV:N')).toBeNull();
		expect(cvssVectorBaseScore(undefined)).toBeNull();
	});
});

/* -------------------------------------------------------------------------- */

describe('npm bulk normalization', () => {
	const advisories = normalizeNpmBulkResponse(NPM_LODASH);

	test('normalizes both advisories of the package', () => {
		expect(advisories).toHaveLength(2);
	});

	test('uses the GHSA parsed out of the url as the canonical id', () => {
		expect(
			extractGhsaId('https://github.com/advisories/GHSA-35jh-r3h4-6jhm')
		).toBe('GHSA-35jh-r3h4-6jhm');
		expect(extractGhsaId('https://example.com/nothing')).toBeUndefined();

		const command = advisories.find((a) => a.sourceId === '1673');
		expect(command?.id).toBe('GHSA-35jh-r3h4-6jhm');
		expect(command?.source).toBe('npm');
		expect(command?.severity).toBe('high');
		expect(command?.cvssScore).toBe(7.2);
		expect(command?.summary).toBe('Command Injection in lodash');
	});

	test('records npm:<id> plus any CVE found in the cwe array as aliases', () => {
		const command = advisories.find((a) => a.sourceId === '1673');
		expect(command?.aliases).toContain('npm:1673');
		expect(command?.aliases).toContain('CVE-2021-23337');
		expect(command?.cweIds).toEqual(['CWE-77', 'CWE-94']);
	});

	test('falls back to the CVE as canonical id when no GHSA url is present', () => {
		const [minimist] = normalizeNpmBulkResponse(NPM_MINIMIST);
		expect(minimist?.id).toBe('CVE-2020-7598');
		expect(minimist?.aliases).toContain('npm:1179');
		expect(minimist?.severity).toBe('low');
	});

	test('carries the vulnerable range and infers the first patched version', () => {
		const command = advisories.find((a) => a.sourceId === '1673');
		expect(command?.ranges).toEqual([
			{
				ecosystem: 'npm',
				packageName: 'lodash',
				vulnerableRange: '<4.17.21',
				firstPatched: '4.17.21',
			},
		]);
		expect(inferFirstPatched('>=3.7.0 <4.17.19')).toBe('4.17.19');
		expect(inferFirstPatched('<0.2.1 || >=1.0.0 <1.2.3')).toBe('1.2.3');
		expect(inferFirstPatched('>=1.0.0')).toBeUndefined();
		expect(inferFirstPatched('not a range')).toBeUndefined();
	});
});

/* -------------------------------------------------------------------------- */

describe('OSV normalization', () => {
	test('picks the canonical id GHSA > CVE > osv id', () => {
		expect(pickCanonicalId(['CVE-2020-1234', 'GHSA-aaaa-bbbb-cccc'])).toBe(
			'GHSA-aaaa-bbbb-cccc'
		);
		expect(pickCanonicalId(['PYSEC-1', 'CVE-2020-1234'])).toBe(
			'CVE-2020-1234'
		);
		expect(pickCanonicalId(['MAL-2024-1'])).toBe('MAL-2024-1');
	});

	test('turns introduced "0" + fixed into a single upper-bound clause', () => {
		const advisory = normalizeOsvVuln(OSV_LODASH_CMD);
		expect(advisory.id).toBe('GHSA-35jh-r3h4-6jhm');
		expect(advisory.aliases).toEqual(['CVE-2021-23337']);
		expect(advisory.ranges).toEqual([
			{
				ecosystem: 'npm',
				packageName: 'lodash',
				vulnerableRange: '<4.17.21',
				firstPatched: '4.17.21',
			},
		]);
		expect(advisory.severity).toBe('high');
		expect(advisory.cvssScore).toBe(9.8);
		expect(advisory.url).toBe(
			'https://github.com/advisories/GHSA-35jh-r3h4-6jhm'
		);
		expect(advisory.publishedAt).toBe('2021-02-15T00:00:00Z');
	});

	test('handles last_affected, multiple ranges and skips GIT ranges', () => {
		const advisory = normalizeOsvVuln(OSV_MINIMIST);
		expect(advisory.ranges).toHaveLength(1);
		expect(advisory.ranges[0]?.vulnerableRange).toBe(
			'<=0.2.0 || >=1.0.0 <1.2.3'
		);
		expect(advisory.ranges[0]?.firstPatched).toBe('1.2.3');
		// database_specific.severity wins over the (absent) CVSS vector.
		expect(advisory.severity).toBe('moderate');
		expect(advisory.cweIds).toEqual(['CWE-1321']);
	});

	test('builds clauses from raw event lists', () => {
		expect(
			osvRangeToClauses({
				type: 'SEMVER',
				events: [{ introduced: '0' }, { fixed: '2.0.0' }],
			})
		).toEqual(['<2.0.0']);
		expect(
			osvRangeToClauses({
				type: 'ECOSYSTEM',
				events: [{ introduced: '1.0.0' }, { last_affected: '1.5.0' }],
			})
		).toEqual(['>=1.0.0 <=1.5.0']);
		expect(
			osvRangeToClauses({ type: 'SEMVER', events: [{ introduced: '0' }] })
		).toEqual(['*']);
		expect(
			osvRangeToClauses({
				type: 'SEMVER',
				events: [{ introduced: '2.1.0' }],
			})
		).toEqual(['>=2.1.0']);
		expect(
			osvRangeToClauses({
				type: 'SEMVER',
				events: [
					{ introduced: '0' },
					{ fixed: '1.2.0' },
					{ introduced: '2.0.0' },
					{ fixed: '2.1.0' },
				],
			})
		).toEqual(['<1.2.0', '>=2.0.0 <2.1.0']);
		expect(
			osvRangeToClauses({ type: 'GIT', events: [{ introduced: '0' }] })
		).toEqual([]);
	});

	test('sorts out-of-order events before pairing them', () => {
		const sorted = sortOsvEvents([
			{ fixed: '2.1.0' },
			{ introduced: '0' },
			{ fixed: '1.2.0' },
			{ introduced: '2.0.0' },
		]);
		expect(sorted).toEqual([
			{ introduced: '0' },
			{ fixed: '1.2.0' },
			{ introduced: '2.0.0' },
			{ fixed: '2.1.0' },
		]);
	});

	test('ignores affected entries from other ecosystems', () => {
		const advisory = normalizeOsvVuln({
			id: 'OSV-1',
			affected: [
				{
					package: { name: 'django', ecosystem: 'PyPI' },
					ranges: [
						{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] },
					],
				},
			],
		});
		expect(advisory.ranges).toEqual([]);
		expect(advisory.id).toBe('OSV-1');
		expect(advisory.url).toBe('https://osv.dev/vulnerability/OSV-1');
	});

	test('keeps affected entries matching the requested ecosystem', () => {
		const advisory = normalizeOsvVuln(
			{
				id: 'OSV-2',
				affected: [
					{
						package: { name: 'Django', ecosystem: 'PyPI' },
						ranges: [
							{
								type: 'ECOSYSTEM',
								events: [
									{ introduced: '0' },
									{ fixed: '4.2.1' },
								],
							},
						],
					},
					{
						package: { name: 'lodash', ecosystem: 'npm' },
						ranges: [
							{ type: 'SEMVER', events: [{ introduced: '0' }] },
						],
					},
				],
			},
			{ ecosystem: 'pypi' }
		);
		expect(advisory.ranges).toEqual([
			{
				ecosystem: 'pypi',
				packageName: 'django',
				vulnerableRange: '<4.2.1',
				firstPatched: '4.2.1',
			},
		]);
	});

	test('pypi renders comma-joined specifiers, one row per interval', () => {
		const advisory = normalizeOsvVuln(
			{
				id: 'OSV-3',
				affected: [
					{
						package: { name: 'pillow', ecosystem: 'PyPI' },
						ranges: [
							{
								type: 'ECOSYSTEM',
								events: [
									{ introduced: '2.0' },
									{ fixed: '9.0.1' },
									{ introduced: '10.0' },
									{ fixed: '10.0.1' },
								],
							},
						],
					},
				],
			},
			{ ecosystem: 'pypi' }
		);
		expect(advisory.ranges).toEqual([
			{
				ecosystem: 'pypi',
				packageName: 'pillow',
				vulnerableRange: '>=2.0,<9.0.1',
				firstPatched: '9.0.1',
			},
			{
				ecosystem: 'pypi',
				packageName: 'pillow',
				vulnerableRange: '>=10.0,<10.0.1',
				firstPatched: '9.0.1',
			},
		]);
	});

	test('pypi exact version lists render as == pins', () => {
		const advisory = normalizeOsvVuln(
			{
				id: 'OSV-4',
				affected: [
					{
						package: { name: 'requests', ecosystem: 'PyPI' },
						versions: ['2.3.0', '2.4.0'],
					},
				],
			},
			{ ecosystem: 'pypi' }
		);
		expect(advisory.ranges.map((range) => range.vulnerableRange)).toEqual([
			'==2.3.0',
			'==2.4.0',
		]);
	});
});

/* -------------------------------------------------------------------------- */

describe('mergeAdvisories', () => {
	const npm = [
		...normalizeNpmBulkResponse(NPM_LODASH),
		...normalizeNpmBulkResponse(NPM_MINIMIST),
	];
	const osv = [OSV_LODASH_CMD, OSV_LODASH_PROTO, OSV_MINIMIST].map((vuln) =>
		normalizeOsvVuln(vuln)
	);
	const merged = mergeAdvisories([npm, osv]);

	test('collapses six source rows into three advisories', () => {
		expect(npm).toHaveLength(3);
		expect(osv).toHaveLength(3);
		expect(merged).toHaveLength(3);
	});

	test('resolves a CVE-only npm advisory onto the OSV GHSA via aliases', () => {
		const minimist = merged.find((a) => a.aliases.includes('npm:1179'));
		expect(minimist?.id).toBe('GHSA-vh95-rmgr-6w4m');
		expect(minimist?.aliases).toContain('CVE-2020-7598');
		expect(minimist?.sources.map((s) => s.source).sort()).toEqual([
			'npm',
			'osv',
		]);
	});

	test('keeps the worst severity across sources', () => {
		const proto = merged.find((a) => a.id === 'GHSA-p6mc-m468-83gg');
		// npm says high, OSV says critical.
		expect(proto?.severity).toBe('critical');

		const minimist = merged.find((a) => a.id === 'GHSA-vh95-rmgr-6w4m');
		// npm says low, OSV says moderate.
		expect(minimist?.severity).toBe('moderate');
	});

	test('unions distinct ranges and dedupes identical ones', () => {
		const proto = merged.find((a) => a.id === 'GHSA-p6mc-m468-83gg');
		expect(proto?.ranges.map((r) => r.vulnerableRange).sort()).toEqual([
			'<4.17.19',
			'>=3.7.0 <4.17.19',
		]);

		const command = merged.find((a) => a.id === 'GHSA-35jh-r3h4-6jhm');
		// Both sources produce the identical `<4.17.21` clause.
		expect(command?.ranges).toHaveLength(1);
		expect(command?.ranges[0]?.firstPatched).toBe('4.17.21');
	});

	test('prefers npm prose but keeps OSV details and both source refs', () => {
		const proto = merged.find((a) => a.id === 'GHSA-p6mc-m468-83gg');
		expect(proto?.summary).toBe('Prototype Pollution in lodash');
		expect(proto?.details).toBe(
			'OSV description of the lodash prototype pollution issue.'
		);
		expect(proto?.url).toBe(
			'https://github.com/advisories/GHSA-p6mc-m468-83gg'
		);
		expect(proto?.sources).toHaveLength(2);
	});

	test('takes the earliest publishedAt and the latest modifiedAt', () => {
		const command = merged.find((a) => a.id === 'GHSA-35jh-r3h4-6jhm');
		expect(command?.publishedAt).toBe('2021-02-15T00:00:00Z');
		expect(command?.modifiedAt).toBe('2024-02-01T00:00:00Z');
	});

	test('merges transitively through a shared alias', () => {
		const result = mergeAdvisories([
			[
				{
					id: 'CVE-2020-0001',
					aliases: ['npm:1'],
					source: 'npm',
					sourceId: '1',
					summary: 'npm text',
					severity: 'low',
					cweIds: [],
					ranges: [
						{
							ecosystem: 'npm' as const,
							packageName: 'x',
							vulnerableRange: '<1.0.0',
						},
					],
					raw: null,
				},
			],
			[
				{
					id: 'GHSA-aaaa-bbbb-cccc',
					aliases: ['CVE-2020-0001'],
					source: 'osv',
					sourceId: 'GHSA-aaaa-bbbb-cccc',
					summary: 'osv text',
					severity: 'critical',
					cweIds: ['CWE-79'],
					ranges: [
						{
							ecosystem: 'npm' as const,
							packageName: 'x',
							vulnerableRange: '<1.0.0',
						},
					],
					raw: null,
				},
			],
		]);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('GHSA-aaaa-bbbb-cccc');
		expect(result[0]?.aliases.sort()).toEqual(['CVE-2020-0001', 'npm:1']);
		expect(result[0]?.severity).toBe('critical');
		expect(result[0]?.summary).toBe('npm text');
		expect(result[0]?.cweIds).toEqual(['CWE-79']);
	});

	test('returns an empty list for empty input', () => {
		expect(mergeAdvisories([])).toEqual([]);
		expect(mergeAdvisories([[], []])).toEqual([]);
	});
});
