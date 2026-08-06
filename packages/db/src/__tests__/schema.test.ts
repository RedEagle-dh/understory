import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../client';
import { id } from '../ids';
import { runMigrations } from '../migrate';
import {
	advisories,
	advisoryRanges,
	appSettings,
	dependencySetEntries,
	dependencySets,
	findings,
	notificationChannels,
	notificationDeliveries,
	notificationRules,
	projects,
	scans,
} from '../schema/index';

function freshDb(): Db {
	const { db } = createDb(':memory:');
	runMigrations(db);
	return db;
}

// Drizzle's query builders are thenables, not real `Promise` instances, so
// `expect(builder).rejects` doesn't recognize them directly. Wrapping in
// `Promise.resolve` normalizes to a genuine Promise first.
async function expectRejects(thenable: PromiseLike<unknown>): Promise<void> {
	await expect(Promise.resolve(thenable)).rejects.toThrow();
}

let db: Db;

beforeEach(() => {
	db = freshDb();
});

describe('appSettings', () => {
	test('inserts the singleton row', async () => {
		const now = new Date();
		await db
			.insert(appSettings)
			.values({ id: 1, createdAt: now, updatedAt: now });
		const rows = await db.select().from(appSettings);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.defaultScanIntervalMinutes).toBe(60);
		expect(rows[0]?.retentionScansPerProject).toBe(200);
		expect(rows[0]?.setupCompletedAt).toBeNull();
	});
});

describe('a full project -> scan -> dependencySet -> finding chain', () => {
	async function seedProject() {
		const now = new Date();
		const projectId = id();
		await db.insert(projects).values({
			id: projectId,
			name: 'demo',
			owner: 'octocat',
			repo: 'demo',
			scanOffsetSeconds: 42,
			nextScanAt: now,
			createdAt: now,
			updatedAt: now,
		});
		return projectId;
	}

	test('inserts a project, scan, dependency set + entries, advisory + range, and a finding', async () => {
		const now = new Date();
		const projectId = await seedProject();

		const scanId = id();
		await db.insert(scans).values({
			id: scanId,
			projectId,
			trigger: 'manual',
			status: 'ok',
			startedAt: now,
			finishedAt: now,
		});

		const setId = id();
		await db.insert(dependencySets).values({
			id: setId,
			projectId,
			lockHash: 'sha256:abc',
			manager: 'bun',
			packageCount: 1,
			directCount: 1,
			createdAt: now,
			firstScanId: scanId,
		});

		await db.insert(dependencySetEntries).values({
			setId,
			name: 'lodash',
			version: '4.17.20',
			depType: 'prod',
			isDirect: true,
			depth: 0,
		});

		const advisoryId = 'GHSA-test-0000';
		await db.insert(advisories).values({
			id: advisoryId,
			summary: 'Prototype pollution in lodash',
			severity: 'high',
			updatedAt: now,
		});

		await db.insert(advisoryRanges).values({
			advisoryId,
			packageName: 'lodash',
			vulnerableRange: '<4.17.21',
		});

		const findingId = id();
		await db.insert(findings).values({
			id: findingId,
			projectId,
			advisoryId,
			packageName: 'lodash',
			packageVersion: '4.17.20',
			severity: 'high',
			isDirect: true,
			depType: 'prod',
			state: 'open',
			firstSeenScanId: scanId,
			firstSeenAt: now,
			lastSeenScanId: scanId,
			lastSeenAt: now,
		});

		const [storedFinding] = await db
			.select()
			.from(findings)
			.where(eq(findings.id, findingId));
		expect(storedFinding?.state).toBe('open');
		expect(storedFinding?.packageName).toBe('lodash');

		const entries = await db
			.select()
			.from(dependencySetEntries)
			.where(eq(dependencySetEntries.setId, setId));
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe('lodash');
	});

	test('cascades project deletion to its scans and findings', async () => {
		const now = new Date();
		const projectId = await seedProject();

		const scanId = id();
		await db.insert(scans).values({
			id: scanId,
			projectId,
			trigger: 'manual',
			status: 'ok',
			startedAt: now,
		});

		const advisoryId = 'GHSA-cascade-0000';
		await db
			.insert(advisories)
			.values({
				id: advisoryId,
				summary: 'x',
				severity: 'low',
				updatedAt: now,
			});

		const findingId = id();
		await db.insert(findings).values({
			id: findingId,
			projectId,
			advisoryId,
			packageName: 'left-pad',
			packageVersion: '1.0.0',
			severity: 'low',
			isDirect: true,
			depType: 'prod',
			state: 'open',
			firstSeenScanId: scanId,
			firstSeenAt: now,
			lastSeenScanId: scanId,
			lastSeenAt: now,
		});

		await db.delete(projects).where(eq(projects.id, projectId));

		expect(
			await db.select().from(scans).where(eq(scans.projectId, projectId))
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(findings)
				.where(eq(findings.projectId, projectId))
		).toHaveLength(0);
		// The advisory itself is global and must survive the project's deletion.
		const [survivingAdvisory] = await db
			.select()
			.from(advisories)
			.where(eq(advisories.id, advisoryId));
		expect(survivingAdvisory).toBeDefined();
	});
});

describe('unique indexes reject duplicates', () => {
	test('projects (owner, repo, branch)', async () => {
		const now = new Date();
		const values = {
			id: id(),
			name: 'demo',
			owner: 'octocat',
			repo: 'demo',
			scanOffsetSeconds: 0,
			nextScanAt: now,
			createdAt: now,
			updatedAt: now,
		};
		await db.insert(projects).values(values);
		await expectRejects(
			db.insert(projects).values({ ...values, id: id() })
		);
	});

	test('projects allows the same (owner, repo) with a different branch', async () => {
		const now = new Date();
		const base = {
			name: 'demo',
			owner: 'octocat',
			repo: 'demo',
			scanOffsetSeconds: 0,
			nextScanAt: now,
			createdAt: now,
			updatedAt: now,
		};
		await db.insert(projects).values({ ...base, id: id(), branch: '' });
		await db
			.insert(projects)
			.values({ ...base, id: id(), branch: 'develop' });
		const rows = await db.select().from(projects);
		expect(rows).toHaveLength(2);
	});

	test('dependencySets (projectId, lockHash)', async () => {
		const now = new Date();
		const projectId = id();
		await db.insert(projects).values({
			id: projectId,
			name: 'demo',
			owner: 'octocat',
			repo: 'demo2',
			scanOffsetSeconds: 0,
			nextScanAt: now,
			createdAt: now,
			updatedAt: now,
		});
		const scanId = id();
		await db
			.insert(scans)
			.values({
				id: scanId,
				projectId,
				trigger: 'manual',
				status: 'ok',
				startedAt: now,
			});

		await db
			.insert(dependencySets)
			.values({
				id: id(),
				projectId,
				lockHash: 'same-hash',
				manager: 'bun',
				packageCount: 0,
				directCount: 0,
				createdAt: now,
				firstScanId: scanId,
			});
		await expectRejects(
			db
				.insert(dependencySets)
				.values({
					id: id(),
					projectId,
					lockHash: 'same-hash',
					manager: 'bun',
					packageCount: 0,
					directCount: 0,
					createdAt: now,
					firstScanId: scanId,
				})
		);
	});

	test('findings (projectId, advisoryId, packageName, packageVersion)', async () => {
		const now = new Date();
		const projectId = id();
		await db.insert(projects).values({
			id: projectId,
			name: 'demo',
			owner: 'octocat',
			repo: 'demo3',
			scanOffsetSeconds: 0,
			nextScanAt: now,
			createdAt: now,
			updatedAt: now,
		});
		const scanId = id();
		await db
			.insert(scans)
			.values({
				id: scanId,
				projectId,
				trigger: 'manual',
				status: 'ok',
				startedAt: now,
			});
		const advisoryId = 'GHSA-dup-0000';
		await db
			.insert(advisories)
			.values({
				id: advisoryId,
				summary: 'x',
				severity: 'low',
				updatedAt: now,
			});

		const findingValues = {
			projectId,
			advisoryId,
			packageName: 'left-pad',
			packageVersion: '1.0.0',
			severity: 'low' as const,
			isDirect: true,
			depType: 'prod' as const,
			state: 'open' as const,
			firstSeenScanId: scanId,
			firstSeenAt: now,
			lastSeenScanId: scanId,
			lastSeenAt: now,
		};
		await db.insert(findings).values({ id: id(), ...findingValues });
		await expectRejects(
			db.insert(findings).values({ id: id(), ...findingValues })
		);
	});

	test('notificationDeliveries (channelId, eventKey)', async () => {
		const now = new Date();
		const channelId = id();
		await db.insert(notificationChannels).values({
			id: channelId,
			name: 'ops-email',
			type: 'email_resend',
			configEnc: 'v1.fake.fake',
			configPublicJson: '{}',
			createdAt: now,
			updatedAt: now,
		});

		const deliveryValues = {
			channelId,
			eventType: 'new_vulnerabilities' as const,
			eventKey: 'finding:abc123',
			createdAt: now,
		};
		await db
			.insert(notificationDeliveries)
			.values({ id: id(), ...deliveryValues });

		// onConflictDoNothing() is the safe-upsert path: a duplicate (channelId,
		// eventKey) is silently dropped rather than throwing.
		await db
			.insert(notificationDeliveries)
			.values({ id: id(), ...deliveryValues })
			.onConflictDoNothing();

		// A plain insert, by contrast, demonstrates the constraint actively rejects.
		await expectRejects(
			db
				.insert(notificationDeliveries)
				.values({ id: id(), ...deliveryValues })
		);

		const rows = await db
			.select()
			.from(notificationDeliveries)
			.where(eq(notificationDeliveries.channelId, channelId));
		expect(rows).toHaveLength(1);
	});

	test('notificationRules (channelId, projectId sentinel, eventType) treats "" as a real value, not NULL', async () => {
		const now = new Date();
		const channelId = id();
		await db.insert(notificationChannels).values({
			id: channelId,
			name: 'discord',
			type: 'discord_webhook',
			configEnc: 'v1.fake.fake',
			configPublicJson: '{}',
			createdAt: now,
			updatedAt: now,
		});

		await db
			.insert(notificationRules)
			.values({ id: id(), channelId, eventType: 'scan_failed' });
		await expectRejects(
			db
				.insert(notificationRules)
				.values({ id: id(), channelId, eventType: 'scan_failed' })
		);
	});
});
