import { beforeEach, describe, expect, test } from 'bun:test';
import type { OsvClient, OsvVuln } from '@workspace/audit-engine';
import { createDb, id, runMigrations, schema } from '@workspace/db';
import { createAdvisoryRefreshService } from '../services/advisory-refresh-service';
import { createAdvisoriesStore } from '../stores/advisories';
import { createFindingsStore } from '../stores/findings';
import { createProjectsStore } from '../stores/projects';

const ADVISORY_ID = 'CVE-2021-0001';
const OLD_MODIFIED = new Date('2020-01-01T00:00:00Z');

function makeOsvClient(byId: Record<string, OsvVuln>): OsvClient {
	return {
		async queryBatch() {
			return [];
		},
		async getVuln(vulnId) {
			const vuln = byId[vulnId];
			if (vuln === undefined) throw new Error(`no fixture for ${vulnId}`);
			return vuln;
		},
	};
}

function baseVuln(overrides: Partial<OsvVuln> = {}): OsvVuln {
	return {
		id: ADVISORY_ID,
		summary: 'lodash prototype pollution',
		details: 'lodash prototype pollution',
		severity: [],
		affected: [
			{
				package: { name: 'lodash', ecosystem: 'npm' },
				ranges: [
					{
						type: 'ECOSYSTEM',
						events: [{ introduced: '0' }, { fixed: '4.17.20' }],
					},
				],
			},
		],
		database_specific: { severity: 'MODERATE' },
		modified: '2024-01-01T00:00:00Z',
		...overrides,
	};
}

async function makeHarness() {
	const { db } = createDb(':memory:');
	runMigrations(db);

	const projects = createProjectsStore(db);
	const advisories = createAdvisoriesStore(db);
	const findings = createFindingsStore(db);

	const project = await projects.create({
		name: 'fixture',
		owner: 'acme',
		repo: 'fixture',
		branch: '',
	});

	await db.insert(schema.advisories).values({
		id: ADVISORY_ID,
		summary: 'lodash prototype pollution',
		severity: 'moderate',
		updatedAt: new Date(),
	});
	await db.insert(schema.advisoryAliases).values({
		alias: ADVISORY_ID,
		advisoryId: ADVISORY_ID,
	});
	await db.insert(schema.advisoryRanges).values({
		advisoryId: ADVISORY_ID,
		ecosystem: 'npm',
		packageName: 'lodash',
		vulnerableRange: '<4.17.20',
	});
	await db.insert(schema.advisorySources).values({
		advisoryId: ADVISORY_ID,
		source: 'osv',
		sourceId: ADVISORY_ID,
		sourceModifiedAt: OLD_MODIFIED,
		fetchedAt: OLD_MODIFIED,
	});

	const findingId = id();
	const now = new Date();
	await db.insert(schema.findings).values({
		id: findingId,
		projectId: project.id,
		advisoryId: ADVISORY_ID,
		packageName: 'lodash',
		packageVersion: '4.17.15',
		workspace: '',
		severity: 'moderate',
		isDirect: true,
		depType: 'prod',
		state: 'open',
		firstSeenScanId: 'seed',
		firstSeenAt: now,
		lastSeenScanId: 'seed',
		lastSeenAt: now,
	});

	return { db, project, advisories, findings, findingId };
}

describe('advisory.refresh', () => {
	let harness: Awaited<ReturnType<typeof makeHarness>>;

	beforeEach(async () => {
		harness = await makeHarness();
	});

	test('skips advisories whose OSV `modified` has not advanced', async () => {
		const osv = makeOsvClient({
			[ADVISORY_ID]: baseVuln({ modified: OLD_MODIFIED.toISOString() }),
		});
		const service = createAdvisoryRefreshService({
			advisories: harness.advisories,
			findings: harness.findings,
			osv,
		});

		const result = await service.refresh(new Date());
		expect(result).toEqual({
			checked: 1,
			refreshed: 0,
			findingsResolved: 0,
			findingsUpdated: 0,
		});

		const finding = await harness.findings.byId(harness.findingId);
		expect(finding?.state).toBe('open');
	});

	test('a shrunk range resolves the finding whose version falls outside it', async () => {
		// The fixed version moves from 4.17.20 down to 4.17.10 — 4.17.15 (the
		// finding's package version) no longer matches.
		const osv = makeOsvClient({
			[ADVISORY_ID]: baseVuln({
				affected: [
					{
						package: { name: 'lodash', ecosystem: 'npm' },
						ranges: [
							{
								type: 'ECOSYSTEM',
								events: [
									{ introduced: '0' },
									{ fixed: '4.17.10' },
								],
							},
						],
					},
				],
			}),
		});
		const service = createAdvisoryRefreshService({
			advisories: harness.advisories,
			findings: harness.findings,
			osv,
		});

		const result = await service.refresh(new Date());
		expect(result).toEqual({
			checked: 1,
			refreshed: 1,
			findingsResolved: 1,
			findingsUpdated: 0,
		});

		const finding = await harness.findings.byId(harness.findingId);
		expect(finding?.state).toBe('resolved');
		expect(finding?.resolvedScanId).toBeNull();
		expect(finding?.resolvedAt).not.toBeNull();
	});

	test('a severity bump propagates onto the still-open finding', async () => {
		const osv = makeOsvClient({
			[ADVISORY_ID]: baseVuln({
				database_specific: { severity: 'CRITICAL' },
			}),
		});
		const service = createAdvisoryRefreshService({
			advisories: harness.advisories,
			findings: harness.findings,
			osv,
		});

		const result = await service.refresh(new Date());
		expect(result).toEqual({
			checked: 1,
			refreshed: 1,
			findingsResolved: 0,
			findingsUpdated: 1,
		});

		const finding = await harness.findings.byId(harness.findingId);
		expect(finding?.state).toBe('open');
		expect(finding?.severity).toBe('critical');

		const advisory = await harness.advisories.advisoryById(ADVISORY_ID);
		expect(advisory?.advisory.severity).toBe('critical');
	});

	test('a withdrawn advisory resolves its open findings regardless of range', async () => {
		const osv = makeOsvClient({
			[ADVISORY_ID]: baseVuln({
				withdrawn: '2024-06-01T00:00:00Z',
			}),
		});
		const service = createAdvisoryRefreshService({
			advisories: harness.advisories,
			findings: harness.findings,
			osv,
		});

		const result = await service.refresh(new Date());
		expect(result).toEqual({
			checked: 1,
			refreshed: 1,
			findingsResolved: 1,
			findingsUpdated: 0,
		});

		const finding = await harness.findings.byId(harness.findingId);
		expect(finding?.state).toBe('resolved');

		const advisory = await harness.advisories.advisoryById(ADVISORY_ID);
		expect(advisory?.advisory.withdrawnAt).not.toBeNull();
	});
});
