import { describe, expect, test } from 'bun:test';
import { planBump } from '../bump-plan';
import { computeFix } from '../fix';
import { computeOutdated } from '../outdated';
import { checkPeers } from '../peers';
import { classifyRange, updateKindBetween } from '../ranges';
import type { DependencyGraph, ParsedDependency } from '../types';

/* -------------------------------------------------------------------------- */

describe('classifyRange', () => {
	test('separates evaluable semver ranges from protocol ranges', () => {
		expect(classifyRange('^1.2.3')).toBe('semver');
		expect(classifyRange('>=1.0.0 <2.0.0')).toBe('semver');
		expect(classifyRange('1.2.x')).toBe('semver');
		expect(classifyRange('*')).toBe('wildcard');
		expect(classifyRange('')).toBe('wildcard');
		expect(classifyRange('latest')).toBe('tag');
		expect(classifyRange('workspace:*')).toBe('workspace');
		expect(classifyRange('catalog:frontend')).toBe('catalog');
		expect(classifyRange('npm:@scope/other@^1.0.0')).toBe('alias');
		expect(classifyRange('file:../local')).toBe('file');
		expect(classifyRange('link:../local')).toBe('link');
		expect(classifyRange('git+https://github.com/a/b.git#v1')).toBe('git');
		expect(classifyRange('github:a/b')).toBe('git');
		expect(classifyRange('https://example.com/pkg.tgz')).toBe('url');
	});
});

describe('updateKindBetween', () => {
	test('classifies the distance between two versions', () => {
		expect(updateKindBetween('1.0.0', '2.0.0')).toBe('major');
		expect(updateKindBetween('1.0.0', '1.1.0')).toBe('minor');
		expect(updateKindBetween('1.0.0', '1.0.1')).toBe('patch');
		expect(updateKindBetween('1.0.0', '1.0.0')).toBe('none');
		expect(updateKindBetween('2.0.0', '1.0.0')).toBe('none');
		expect(updateKindBetween('garbage', '1.0.0')).toBe('none');
	});
});

/* -------------------------------------------------------------------------- */

describe('computeOutdated', () => {
	const versions = {
		'1.2.3': {},
		'1.5.0': {},
		'2.0.0-rc.1': {},
		'2.0.0': {},
	};

	test('computes latest, wanted and a major update kind', () => {
		expect(
			computeOutdated({
				current: '1.2.3',
				declaredRange: '^1.0.0',
				distTags: { latest: '2.0.0' },
				versions,
			})
		).toMatchObject({
			latest: '2.0.0',
			wanted: '1.5.0',
			updateKind: 'major',
			outdated: true,
			rangeUnsupported: false,
		});
	});

	test('reports none when already on latest or ahead of it', () => {
		expect(
			computeOutdated({ current: '2.0.0', distTags: { latest: '2.0.0' } })
		).toMatchObject({
			updateKind: 'none',
			outdated: false,
		});
		expect(
			computeOutdated({ current: '3.0.0', distTags: { latest: '2.0.0' } })
		).toMatchObject({
			updateKind: 'none',
		});
	});

	test('classifies minor and patch updates', () => {
		expect(
			computeOutdated({ current: '1.0.0', distTags: { latest: '1.1.0' } })
				.updateKind
		).toBe('minor');
		expect(
			computeOutdated({ current: '1.0.0', distTags: { latest: '1.0.1' } })
				.updateKind
		).toBe('patch');
	});

	test('treats a prerelease on the same tuple as a patch update', () => {
		expect(
			computeOutdated({
				current: '2.0.0-rc.1',
				distTags: { latest: '2.0.0' },
			})
		).toMatchObject({ updateKind: 'patch', outdated: true });
		expect(
			computeOutdated({
				current: '2.0.0-rc.1',
				distTags: { latest: '3.0.0' },
			}).updateKind
		).toBe('major');
	});

	test('never picks a prerelease as wanted', () => {
		expect(
			computeOutdated({
				current: '1.5.0',
				declaredRange: '>=1.0.0',
				distTags: { latest: '2.0.0' },
				versions,
			}).wanted
		).toBe('2.0.0');
	});

	test('flags declared ranges that cannot be evaluated', () => {
		const result = computeOutdated({
			current: '1.0.0',
			declaredRange: 'workspace:*',
			distTags: { latest: '2.0.0' },
			versions,
		});
		expect(result.rangeUnsupported).toBe(true);
		expect(result.wanted).toBeUndefined();
		expect(result.updateKind).toBe('major');
	});

	test('falls back to latest as wanted when no version list is available', () => {
		expect(
			computeOutdated({
				current: '1.2.3',
				declaredRange: '^1.0.0',
				distTags: { latest: '1.9.0' },
			}).wanted
		).toBe('1.9.0');
		expect(
			computeOutdated({
				current: '1.2.3',
				declaredRange: '^1.0.0',
				distTags: { latest: '2.0.0' },
			}).wanted
		).toBeUndefined();
	});

	test('surfaces the deprecation of the installed version', () => {
		expect(
			computeOutdated({
				current: '1.2.3',
				distTags: { latest: '2.0.0' },
				versions: { '1.2.3': { deprecated: 'no longer maintained' } },
			}).deprecated
		).toBe('no longer maintained');
	});

	test('degrades gracefully without dist-tags', () => {
		expect(
			computeOutdated({ current: '1.0.0', distTags: {} })
		).toMatchObject({
			latest: undefined,
			updateKind: 'none',
			outdated: false,
		});
	});
});

/* -------------------------------------------------------------------------- */

describe('computeFix', () => {
	const availableVersions = [
		{ version: '4.17.15' },
		{ version: '4.17.16' },
		{ version: '4.17.19' },
		{ version: '4.17.20' },
		{ version: '4.17.21', deprecated: 'broken release' },
		{ version: '4.17.22' },
		{ version: '5.0.0-beta.1' },
		{ version: '5.0.0' },
	];

	test('finds the minimal version satisfying none of several overlapping ranges', () => {
		expect(
			computeFix({
				currentVersion: '4.17.15',
				declaredRange: '^4.17.0',
				allRangesForPackage: ['<4.17.19', '>=4.17.0 <4.17.20'],
				availableVersions,
			})
		).toMatchObject({
			fixedIn: '4.17.20',
			fixType: 'patch',
			fixWithinRange: true,
		});
	});

	test('skips deprecated and prerelease versions', () => {
		expect(
			computeFix({
				currentVersion: '4.17.15',
				declaredRange: '^4.17.0',
				allRangesForPackage: ['<4.17.21'],
				availableVersions,
			})
		).toMatchObject({ fixedIn: '4.17.22', fixType: 'patch' });

		expect(
			computeFix({
				currentVersion: '4.17.15',
				declaredRange: '^4.17.0',
				allRangesForPackage: ['<5.0.0'],
				availableVersions,
			})
		).toMatchObject({
			fixedIn: '5.0.0',
			fixType: 'major',
			fixWithinRange: false,
		});
	});

	test('never suggests a downgrade', () => {
		expect(
			computeFix({
				currentVersion: '4.17.22',
				allRangesForPackage: ['<4.17.19'],
				availableVersions,
			})
		).toMatchObject({ fixedIn: '5.0.0' });
	});

	test('returns no fix when every published version is vulnerable', () => {
		expect(
			computeFix({
				currentVersion: '4.17.15',
				allRangesForPackage: ['*'],
				availableVersions,
			})
		).toEqual({
			fixedIn: null,
			fixType: 'none',
			fixWithinRange: false,
			ignoredRanges: [],
		});
	});

	test('ignores ranges it cannot parse and reports them', () => {
		const result = computeFix({
			currentVersion: '4.17.15',
			allRangesForPackage: ['not-a-range', '<4.17.19'],
			availableVersions,
		});
		expect(result.fixedIn).toBe('4.17.19');
		expect(result.ignoredRanges).toEqual(['not-a-range']);
	});

	test('matches vulnerable ranges with includePrerelease', () => {
		expect(
			computeFix({
				currentVersion: '1.0.0',
				allRangesForPackage: ['<2.0.0'],
				availableVersions: ['2.0.0-beta.1', '2.0.0'],
			})
		).toMatchObject({ fixedIn: '2.0.0', fixType: 'major' });
	});

	test('accepts plain version strings and a missing declared range', () => {
		expect(
			computeFix({
				currentVersion: '1.0.0',
				allRangesForPackage: ['<1.5.0'],
				availableVersions: ['1.4.0', '1.5.0'],
			})
		).toMatchObject({ fixedIn: '1.5.0', fixWithinRange: false });
	});
});

/* -------------------------------------------------------------------------- */

function dependency(
	partial: Partial<ParsedDependency> & { name: string }
): ParsedDependency {
	return {
		version: '1.0.0',
		workspace: '',
		depType: 'prod',
		isDirect: false,
		depth: 1,
		...partial,
	};
}

function graphOf(dependencies: ParsedDependency[]): DependencyGraph {
	return {
		ecosystem: 'npm',
		manager: 'npm',
		workspaces: ['', 'apps/web'],
		dependencies,
		warnings: [],
	};
}

describe('checkPeers', () => {
	const graph = graphOf([
		dependency({
			name: 'react',
			version: '18.3.1',
			isDirect: true,
			depth: 0,
		}),
		dependency({
			name: 'react-dom',
			version: '18.3.1',
			peerDeps: { react: { range: '^18.0.0', optional: false } },
		}),
		dependency({
			name: 'legacy-widget',
			version: '2.0.0',
			peerDeps: { react: { range: '^17.0.0', optional: false } },
		}),
		dependency({
			name: 'needs-vue',
			version: '1.0.0',
			peerDeps: { vue: { range: '^3.0.0', optional: false } },
		}),
		dependency({
			name: 'tolerates-types',
			version: '1.0.0',
			peerDeps: { '@types/react': { range: '^18.0.0', optional: true } },
		}),
		dependency({
			name: 'optional-but-wrong',
			version: '1.0.0',
			peerDeps: { react: { range: '^17.0.0', optional: true } },
		}),
		dependency({ name: 'thing', version: '1.0.0' }),
		dependency({
			name: 'weird-peer',
			version: '1.0.0',
			peerDeps: { thing: { range: 'workspace:*', optional: false } },
		}),
		dependency({
			name: 'workspace-consumer',
			version: '1.0.0',
			workspace: 'apps/web',
			peerDeps: { react: { range: '^18.0.0', optional: false } },
		}),
	]);

	const issues = checkPeers(graph);

	test('reports a missing required peer', () => {
		expect(issues).toContainEqual({
			packageName: 'vue',
			requiredBy: 'needs-vue',
			requiredByVersion: '1.0.0',
			requiredRange: '^3.0.0',
			kind: 'missing',
			optional: false,
			workspace: '',
		});
	});

	test('reports a resolved-but-incompatible peer', () => {
		expect(issues).toContainEqual({
			packageName: 'react',
			requiredBy: 'legacy-widget',
			requiredByVersion: '2.0.0',
			requiredRange: '^17.0.0',
			resolvedVersion: '18.3.1',
			kind: 'invalid',
			optional: false,
			workspace: '',
		});
	});

	test('does not report satisfied peers', () => {
		expect(issues.some((issue) => issue.requiredBy === 'react-dom')).toBe(
			false
		);
	});

	test('resolves through the hoisted root workspace', () => {
		expect(
			issues.some((issue) => issue.requiredBy === 'workspace-consumer')
		).toBe(false);
	});

	test('omits missing optional peers by default but reports invalid ones', () => {
		expect(
			issues.some((issue) => issue.requiredBy === 'tolerates-types')
		).toBe(false);
		expect(issues).toContainEqual({
			packageName: 'react',
			requiredBy: 'optional-but-wrong',
			requiredByVersion: '1.0.0',
			requiredRange: '^17.0.0',
			resolvedVersion: '18.3.1',
			kind: 'invalid',
			optional: true,
			workspace: '',
		});
	});

	test('can opt into missing optional peers', () => {
		const all = checkPeers(graph, { includeMissingOptional: true });
		const optionalMissing = all.find(
			(issue) => issue.requiredBy === 'tolerates-types'
		);
		expect(optionalMissing).toMatchObject({
			kind: 'missing',
			optional: true,
		});
	});

	test('skips resolved peers whose range cannot be evaluated', () => {
		expect(issues.some((issue) => issue.requiredBy === 'weird-peer')).toBe(
			false
		);
	});

	test('still reports a peer that is missing entirely, whatever its range', () => {
		const missing = checkPeers(
			graphOf([
				dependency({
					name: 'weird-peer',
					peerDeps: {
						absent: { range: 'workspace:*', optional: false },
					},
				}),
			])
		);
		expect(missing).toHaveLength(1);
		expect(missing[0]).toMatchObject({
			packageName: 'absent',
			kind: 'missing',
		});
	});

	test('returns nothing for a graph without peer metadata', () => {
		expect(checkPeers(graphOf([dependency({ name: 'lonely' })]))).toEqual(
			[]
		);
	});
});

/* -------------------------------------------------------------------------- */

describe('planBump', () => {
	test('preserves the caret, tilde and exact operators', () => {
		expect(
			planBump({ declaredRange: '^4.17.15', targetVersion: '4.17.21' })
		).toEqual({
			newRange: '^4.17.21',
			changed: true,
		});
		expect(
			planBump({ declaredRange: '~1.2.0', targetVersion: '1.2.6' })
		).toEqual({
			newRange: '~1.2.6',
			changed: true,
		});
		expect(
			planBump({ declaredRange: '1.2.0', targetVersion: '1.2.6' })
		).toEqual({
			newRange: '1.2.6',
			changed: true,
		});
		expect(
			planBump({ declaredRange: '=1.2.0', targetVersion: '1.2.6' })
		).toEqual({
			newRange: '=1.2.6',
			changed: true,
		});
		expect(
			planBump({ declaredRange: '^v1.2.3', targetVersion: '1.2.6' })
		).toEqual({
			newRange: '^v1.2.6',
			changed: true,
		});
	});

	test('rewrites open-ended and compound ranges to a caret', () => {
		expect(
			planBump({ declaredRange: '>=1.0.0', targetVersion: '1.2.6' })
				.newRange
		).toBe('^1.2.6');
		expect(
			planBump({
				declaredRange: '>=1.0.0 <2.0.0',
				targetVersion: '2.1.0',
			}).newRange
		).toBe('^2.1.0');
		expect(
			planBump({ declaredRange: '1.2.x', targetVersion: '1.3.0' })
				.newRange
		).toBe('^1.3.0');
	});

	test('leaves protocol and tag ranges untouched (lockfile-only bump)', () => {
		for (const declaredRange of [
			'*',
			'latest',
			'workspace:*',
			'catalog:',
			'catalog:frontend',
			'file:../local',
			'link:../local',
			'npm:other@^1.0.0',
			'github:a/b',
			'git+https://github.com/a/b.git#v1',
			'https://example.com/pkg.tgz',
		]) {
			expect(planBump({ declaredRange, targetVersion: '9.9.9' })).toEqual(
				{
					newRange: declaredRange,
					changed: false,
					reason: 'not-semver',
				}
			);
		}
	});

	test('reports no change when the range already points at the target', () => {
		expect(
			planBump({ declaredRange: '^1.2.6', targetVersion: '1.2.6' })
		).toEqual({
			newRange: '^1.2.6',
			changed: false,
			reason: 'already-target',
		});
	});

	test('refuses an invalid target version', () => {
		expect(
			planBump({
				declaredRange: '^1.0.0',
				targetVersion: 'not-a-version',
			})
		).toEqual({
			newRange: '^1.0.0',
			changed: false,
			reason: 'invalid-target',
		});
	});

	test('accepts a v-prefixed target', () => {
		expect(
			planBump({ declaredRange: '^1.0.0', targetVersion: 'v1.2.3' })
				.newRange
		).toBe('^1.2.3');
	});
});
