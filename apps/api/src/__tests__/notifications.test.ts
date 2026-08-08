import { beforeEach, describe, expect, test } from 'bun:test';
import { t } from '@declarativejs/core';
import { createDb, id, runMigrations, schema } from '@workspace/db';
import { createSecretBox } from '@workspace/db/crypto';
import { eq } from 'drizzle-orm';
import { createDiscordWebhookProvider } from '../adapters/notifications/discord-webhook';
import type {
	DeliveryResult,
	NotificationMessage,
	NotificationProviderPort,
	NotificationProviderType,
} from '../adapters/notifications/port';
import { buildNewVulnerabilitiesMessage } from '../adapters/notifications/templates/new-vulnerabilities';
import {
	toDiscordEmbeds,
	toHtml,
	toPlainText,
} from '../adapters/notifications/templates/render';
import { buildScanFailedMessage } from '../adapters/notifications/templates/scan-failed';
import {
	computeEventKey,
	createNotificationService,
	MAX_DELIVERY_ATTEMPTS,
} from '../services/notification-service';
import type { ScanDiffFinding } from '../services/ports';
import { createDependencyStatusStore } from '../stores/dependency-status';
import { createNotificationsStore } from '../stores/notifications';
import { createProjectsStore } from '../stores/projects';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function finding(
	overrides: Partial<ScanDiffFinding> & { findingId: string }
): ScanDiffFinding {
	return {
		advisoryId: 'GHSA-xxxx',
		packageName: 'lodash',
		packageVersion: '4.17.15',
		workspace: '',
		severity: 'high',
		isDirect: true,
		fixedIn: '4.17.21',
		fixType: 'patch',
		summary: 'Command injection in lodash',
		url: 'https://github.com/advisories/GHSA-xxxx',
		...overrides,
	};
}

interface FakeProvider extends NotificationProviderPort {
	sent: { config: Record<string, unknown>; message: NotificationMessage }[];
	result: DeliveryResult;
}

function makeFakeProvider(): FakeProvider {
	const provider: FakeProvider = {
		type: 'discord_webhook',
		configSchema: t.Object({}, { additionalProperties: true }),
		secretFields: ['webhookUrl'],
		sent: [],
		result: { ok: true },
		publicView: () => ({}),
		async send(config, message) {
			provider.sent.push({
				config: config as Record<string, unknown>,
				message,
			});
			return provider.result;
		},
	};
	return provider;
}

/** Mirrors `services/crypto-service.channelConfigAad` without importing env. */
function channelConfigAad(channelId: string): string {
	return `notification-channel:${channelId}`;
}

function makeHarness() {
	const { db } = createDb(':memory:');
	runMigrations(db);
	db.insert(schema.appSettings)
		.values({ id: 1, createdAt: new Date(), updatedAt: new Date() })
		.run();

	const secretBox = createSecretBox({
		current: Buffer.from(
			crypto.getRandomValues(new Uint8Array(32))
		).toString('base64'),
	});

	const notifications = createNotificationsStore(db, {
		seal: (channelId, config) =>
			secretBox.seal(JSON.stringify(config), channelConfigAad(channelId)),
		open: async (channelId, sealed) =>
			JSON.parse(
				await secretBox.open(sealed, channelConfigAad(channelId))
			) as Record<string, unknown>,
	});
	const projects = createProjectsStore(db);
	const dependencyStatus = createDependencyStatusStore(db);
	const provider = makeFakeProvider();

	let now = new Date('2026-03-01T08:00:00.000Z');
	const service = createNotificationService({
		notifications,
		projects,
		dependencyStatus,
		baseUrl: 'https://audit.example.com',
		providers: {
			discord_webhook: provider,
			email_resend: provider,
			slack_webhook: provider,
			webhook: provider,
		} as Record<NotificationProviderType, NotificationProviderPort>,
		now: () => now,
	});

	return {
		db,
		secretBox,
		notifications,
		projects,
		dependencyStatus,
		provider,
		service,
		setNow(next: Date) {
			now = next;
		},
		getNow: () => now,
	};
}

type Harness = ReturnType<typeof makeHarness>;

async function makeChannel(harness: Harness, name = 'ops') {
	return harness.notifications.channels.create({
		name,
		type: 'discord_webhook',
		config: { webhookUrl: 'https://discord.com/api/webhooks/1/secret' },
		configPublic: { host: 'discord.com', webhookId: '1' },
	});
}

async function makeProject(harness: Harness, name = 'fixture-app') {
	return harness.projects.create({
		name,
		owner: 'acme',
		repo: name,
		branch: '',
	});
}

/* -------------------------------------------------------------------------- */
/* Templates + renderers                                                      */
/* -------------------------------------------------------------------------- */

describe('notification templates', () => {
	const message = buildNewVulnerabilitiesMessage({
		projectId: 'p1',
		projectName: 'fixture-app',
		scanId: 's1',
		baseUrl: 'https://audit.example.com',
		findings: [
			finding({ findingId: 'f1', severity: 'critical' }),
			finding({ findingId: 'f2', severity: 'high' }),
			finding({
				findingId: 'f3',
				severity: 'low',
				packageName: 'left-pad',
				fixedIn: null,
				fixType: 'none',
			}),
		],
	});

	test('names the project, counts the findings and links into the UI', () => {
		expect(message.title).toContain('fixture-app');
		expect(message.title).toContain('3 new');
		expect(message.severity).toBe('critical');
		expect(message.url).toBe(
			'https://audit.example.com/projects/p1/vulnerabilities'
		);
		expect(message.summary).toContain('2 of 3');
		expect(message.sections.map((section) => section.heading)).toEqual([
			'CRITICAL (1)',
			'HIGH (1)',
			'LOW (1)',
		]);
	});

	test('plain text carries severity labels and package coordinates', () => {
		const text = toPlainText(message);
		expect(text).toContain('[CRITICAL]');
		expect(text).toContain('lodash@4.17.15');
		expect(text).toContain('fix: 4.17.21');
		expect(text).toContain('no fix available');
	});

	test('html is self-contained with inline severity colours', () => {
		const html = toHtml(message);
		expect(html).toContain('#dc2626');
		expect(html).toContain('fixture-app');
		expect(html).not.toContain('<style');
		expect(html).not.toContain('<script');
	});

	test('scan_failed reports the streak and stays under the failure bucket', () => {
		const failed = buildScanFailedMessage({
			projectId: 'p1',
			projectName: 'fixture-app',
			scanId: 's1',
			errorCode: 'GITHUB_HTTP_404',
			errorMessage: 'repository not found',
			failureBucket: 3,
			baseUrl: 'https://audit.example.com',
		});
		expect(failed.title).toContain('3 consecutive failures');
		expect(failed.severity).toBe('high');
		expect(toPlainText(failed)).toContain('GITHUB_HTTP_404');
	});
});

describe('discord rendering limits', () => {
	test('12 sections collapse into 10 embeds ending in a "+N more" notice', () => {
		const embeds = toDiscordEmbeds({
			event: 'new_vulnerabilities',
			title: 'many findings',
			summary: 'lots',
			url: 'https://audit.example.com/projects/p1/vulnerabilities',
			sections: Array.from({ length: 12 }, (_unused, index) => ({
				heading: `section ${index}`,
				lines: [{ text: `line ${index}` }],
			})),
		});

		expect(embeds).toHaveLength(10);
		expect(embeds.at(-1)?.title).toBe('+4 more');
		expect(embeds.at(-1)?.description).toContain('audit.example.com');
	});

	test('descriptions are clamped to Discord’s 4096-character ceiling', () => {
		const embeds = toDiscordEmbeds({
			event: 'new_vulnerabilities',
			title: 'huge',
			summary: 'x'.repeat(9000),
			sections: [],
		});
		expect(embeds[0]?.description.length).toBeLessThanOrEqual(4096);
	});

	test('publicView exposes the webhook id but never the token', () => {
		const view = createDiscordWebhookProvider().publicView({
			webhookUrl:
				'https://discord.com/api/webhooks/123456/super-secret-token',
		});
		expect(view).toEqual({ host: 'discord.com', webhookId: '123456' });
		expect(JSON.stringify(view)).not.toContain('super-secret-token');
	});
});

/* -------------------------------------------------------------------------- */
/* Rule resolution                                                            */
/* -------------------------------------------------------------------------- */

describe('rule resolution', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = makeHarness();
	});

	test('a global rule (projectId "") matches every project', async () => {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: '',
			eventType: 'new_vulnerabilities',
		});

		await harness.service.dispatchEvent({
			type: 'new_vulnerabilities',
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			findings: [finding({ findingId: 'f1' })],
		});

		expect(harness.provider.sent).toHaveLength(1);
		expect(harness.provider.sent[0]?.message.projectName).toBe(
			'fixture-app'
		);
	});

	test('a rule for another project does not match', async () => {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: 'some-other-project',
			eventType: 'new_vulnerabilities',
		});

		await harness.service.dispatchEvent({
			type: 'new_vulnerabilities',
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			findings: [finding({ findingId: 'f1' })],
		});

		expect(harness.provider.sent).toHaveLength(0);
	});

	test('a disabled channel silences its rules', async () => {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: '',
			eventType: 'new_vulnerabilities',
		});
		await harness.notifications.channels.update(channel.id, {
			enabled: false,
		});

		await harness.service.dispatchEvent({
			type: 'new_vulnerabilities',
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			findings: [finding({ findingId: 'f1' })],
		});
		expect(harness.provider.sent).toHaveLength(0);
	});

	test('minSeverity filters the items, keeping the message', async () => {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: project.id,
			eventType: 'new_vulnerabilities',
			minSeverity: 'high',
		});

		await harness.service.dispatchEvent({
			type: 'new_vulnerabilities',
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			findings: [
				finding({ findingId: 'f1', severity: 'critical' }),
				finding({ findingId: 'f2', severity: 'low' }),
				finding({ findingId: 'f3', severity: 'moderate' }),
			],
		});

		expect(harness.provider.sent).toHaveLength(1);
		const sections = harness.provider.sent[0]?.message.sections ?? [];
		expect(sections.map((section) => section.heading)).toEqual([
			'CRITICAL (1)',
		]);
	});

	test('nothing above the threshold means no delivery row at all', async () => {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: '',
			eventType: 'new_vulnerabilities',
			minSeverity: 'critical',
		});

		await harness.service.dispatchEvent({
			type: 'new_vulnerabilities',
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			findings: [finding({ findingId: 'f1', severity: 'low' })],
		});

		expect(harness.provider.sent).toHaveLength(0);
		const rows = await harness.db
			.select()
			.from(schema.notificationDeliveries);
		expect(rows).toHaveLength(0);
	});

	test('a project rule wins over a global one on the same channel', async () => {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: '',
			eventType: 'new_vulnerabilities',
			minSeverity: 'critical',
		});
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: project.id,
			eventType: 'new_vulnerabilities',
			minSeverity: 'low',
		});

		await harness.service.dispatchEvent({
			type: 'new_vulnerabilities',
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			findings: [finding({ findingId: 'f1', severity: 'low' })],
		});

		expect(harness.provider.sent).toHaveLength(1);
		const rows = await harness.db
			.select()
			.from(schema.notificationDeliveries);
		expect(rows).toHaveLength(1);
	});
});

/* -------------------------------------------------------------------------- */
/* Dedupe                                                                     */
/* -------------------------------------------------------------------------- */

describe('dedupe', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = makeHarness();
	});

	test('dispatching the same event twice sends once', async () => {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: '',
			eventType: 'new_vulnerabilities',
		});

		const event = {
			type: 'new_vulnerabilities',
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			findings: [
				finding({ findingId: 'f1' }),
				finding({ findingId: 'f2' }),
			],
		} as const;

		await harness.service.dispatchEvent(event);
		// A different scan id, same findings — deliberately still the same
		// logical event, so the second dispatch must be a no-op.
		await harness.service.dispatchEvent({ ...event, scanId: 's2' });

		expect(harness.provider.sent).toHaveLength(1);
		const rows = await harness.db
			.select()
			.from(schema.notificationDeliveries);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe('sent');
	});

	test('the event key is order-independent and scoped by event + project', () => {
		const base = {
			projectId: 'p1',
			projectName: 'fixture-app',
			scanId: 's1',
		};
		const forward = computeEventKey({
			...base,
			type: 'new_vulnerabilities',
			findings: [
				finding({ findingId: 'a' }),
				finding({ findingId: 'b' }),
			],
		});
		const reversed = computeEventKey({
			...base,
			type: 'new_vulnerabilities',
			findings: [
				finding({ findingId: 'b' }),
				finding({ findingId: 'a' }),
			],
		});
		expect(forward).toBe(reversed);
		expect(forward.startsWith('new_vulnerabilities:p1:')).toBe(true);

		const otherProject = computeEventKey({
			...base,
			projectId: 'p2',
			type: 'new_vulnerabilities',
			findings: [finding({ findingId: 'a' })],
		});
		expect(otherProject).not.toBe(forward);
	});

	test('scan failures dedupe per streak bucket, not per scan', () => {
		const first = computeEventKey({
			type: 'scan_failed',
			projectId: 'p1',
			projectName: 'fixture-app',
			scanId: 's1',
			errorCode: 'GITHUB_HTTP_404',
			errorMessage: 'gone',
			failureBucket: 1,
		});
		const sameBucket = computeEventKey({
			type: 'scan_failed',
			projectId: 'p1',
			projectName: 'fixture-app',
			scanId: 's99',
			errorCode: 'GITHUB_HTTP_404',
			errorMessage: 'gone',
			failureBucket: 1,
		});
		const laterBucket = computeEventKey({
			type: 'scan_failed',
			projectId: 'p1',
			projectName: 'fixture-app',
			scanId: 's99',
			errorCode: 'GITHUB_HTTP_404',
			errorMessage: 'gone',
			failureBucket: 3,
		});
		expect(first).toBe(sameBucket);
		expect(first).not.toBe(laterBucket);
	});
});

/* -------------------------------------------------------------------------- */
/* Retry                                                                      */
/* -------------------------------------------------------------------------- */

describe('retry semantics', () => {
	let harness: Harness;

	async function dispatchOne() {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: '',
			eventType: 'new_vulnerabilities',
		});
		await harness.service.dispatchEvent({
			type: 'new_vulnerabilities',
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			findings: [finding({ findingId: 'f1' })],
		});
		const [row] = await harness.db
			.select()
			.from(schema.notificationDeliveries);
		if (row === undefined) throw new Error('no delivery row');
		return { channel, project, row };
	}

	beforeEach(() => {
		harness = makeHarness();
	});

	test('a retryable failure schedules the next attempt', async () => {
		harness.provider.result = {
			ok: false,
			retryable: true,
			error: 'rate limited',
		};
		const { row, channel } = await dispatchOne();

		expect(row.status).toBe('failed');
		expect(row.attempts).toBe(1);
		expect(row.nextAttemptAt?.getTime()).toBe(
			harness.getNow().getTime() + 60_000
		);
		expect(row.payloadJson).not.toBeNull();

		const [stored] = await harness.db
			.select()
			.from(schema.notificationChannels)
			.where(eq(schema.notificationChannels.id, channel.id));
		expect(stored?.lastError).toContain('rate limited');
	});

	test('retryFailed re-sends the stored payload once the backoff elapses', async () => {
		harness.provider.result = {
			ok: false,
			retryable: true,
			error: 'rate limited',
		};
		const { row } = await dispatchOne();
		const originalTitle = JSON.parse(row.payloadJson ?? '{}').title;

		// Too early: the delivery is not due yet.
		expect(
			(await harness.service.retryFailed(harness.getNow())).retried
		).toBe(0);

		harness.provider.result = { ok: true };
		harness.setNow(new Date(harness.getNow().getTime() + 61_000));
		const result = await harness.service.retryFailed(harness.getNow());

		expect(result).toEqual({ retried: 1, sent: 1, skipped: 0 });
		expect(harness.provider.sent).toHaveLength(2);
		expect(harness.provider.sent[1]?.message.title).toBe(originalTitle);

		const [after] = await harness.db
			.select()
			.from(schema.notificationDeliveries);
		expect(after?.status).toBe('sent');
		expect(after?.attempts).toBe(2);
		expect(after?.nextAttemptAt).toBeNull();
	});

	test('a non-retryable failure is never retried', async () => {
		harness.provider.result = {
			ok: false,
			retryable: false,
			error: 'webhook deleted',
		};
		const { row } = await dispatchOne();

		expect(row.status).toBe('failed');
		expect(row.nextAttemptAt).toBeNull();
		expect(
			(
				await harness.service.retryFailed(
					new Date(harness.getNow().getTime() + 86_400_000)
				)
			).retried
		).toBe(0);
	});

	test('the delivery is abandoned after six attempts', async () => {
		harness.provider.result = {
			ok: false,
			retryable: true,
			error: 'still down',
		};
		const { row } = await dispatchOne();

		// Fast-forward to the last permitted attempt.
		harness.db
			.update(schema.notificationDeliveries)
			.set({
				attempts: MAX_DELIVERY_ATTEMPTS - 1,
				nextAttemptAt: new Date(harness.getNow().getTime() - 1000),
			})
			.where(eq(schema.notificationDeliveries.id, row.id))
			.run();

		const result = await harness.service.retryFailed(harness.getNow());
		expect(result.retried).toBe(1);

		const [after] = await harness.db
			.select()
			.from(schema.notificationDeliveries);
		expect(after?.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
		expect(after?.nextAttemptAt).toBeNull();
		expect(
			(
				await harness.service.retryFailed(
					new Date(harness.getNow().getTime() + 86_400_000)
				)
			).retried
		).toBe(0);
	});

	test('a provider honours its own retryAfterMs over the backoff table', async () => {
		harness.provider.result = {
			ok: false,
			retryable: true,
			error: 'slow down',
			retryAfterMs: 4500,
		};
		const { row } = await dispatchOne();
		expect(row.nextAttemptAt?.getTime()).toBe(
			harness.getNow().getTime() + 4500
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Scan notifier + digest                                                     */
/* -------------------------------------------------------------------------- */

describe('scan notifier port', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = makeHarness();
	});

	test('scanDiff fans out to the events its rules subscribe to', async () => {
		const channel = await makeChannel(harness);
		const project = await harness.projects.create({
			name: 'fixture-app',
			owner: 'acme',
			repo: 'fixture-app',
			branch: '',
		});
		await harness.projects.update(project.id, { notifyOnNewMajor: true });
		for (const eventType of [
			'new_vulnerabilities',
			'resolved_vulnerabilities',
			'new_major',
		] as const) {
			await harness.notifications.rules.upsert({
				channelId: channel.id,
				projectId: '',
				eventType,
			});
		}

		await harness.service.notifier.scanDiff({
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			newFindings: [finding({ findingId: 'f1' })],
			resolvedFindings: [finding({ findingId: 'f2' })],
			newMajors: [
				{
					packageName: 'react',
					workspace: '',
					currentVersion: '18.2.0',
					previousLatestVersion: '18.3.1',
					latestVersion: '19.0.0',
				},
			],
		});

		expect(
			harness.provider.sent.map((entry) => entry.message.event)
		).toEqual([
			'new_vulnerabilities',
			'resolved_vulnerabilities',
			'new_major',
		]);
	});

	test('new_major stays silent unless the project opts in', async () => {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: '',
			eventType: 'new_major',
		});

		await harness.service.notifier.scanDiff({
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			newFindings: [],
			resolvedFindings: [],
			newMajors: [
				{
					packageName: 'react',
					workspace: '',
					currentVersion: '18.2.0',
					previousLatestVersion: '18.3.1',
					latestVersion: '19.0.0',
				},
			],
		});
		expect(harness.provider.sent).toHaveLength(0);
	});

	test('scanFailed carries the streak into the message', async () => {
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: '',
			eventType: 'scan_failed',
		});

		await harness.service.notifier.scanFailed({
			projectId: project.id,
			projectName: project.name,
			scanId: 's1',
			errorCode: 'GITHUB_HTTP_404',
			errorMessage: 'repository not found',
			consecutiveFailures: 3,
		});

		expect(harness.provider.sent).toHaveLength(1);
		expect(harness.provider.sent[0]?.message.title).toContain(
			'3 consecutive failures'
		);
	});
});

describe('outdated digest', () => {
	test('sends one digest per project per day', async () => {
		const harness = makeHarness();
		const channel = await makeChannel(harness);
		const project = await makeProject(harness);
		await harness.notifications.rules.upsert({
			channelId: channel.id,
			projectId: '',
			eventType: 'outdated_digest',
		});

		await harness.dependencyStatus.replaceForScan(
			project.id,
			'scan-1',
			new Date(),
			[
				{
					workspace: '',
					packageName: 'react',
					currentVersion: '18.2.0',
					declaredRange: '^18.0.0',
					wantedVersion: '18.3.1',
					latestVersion: '19.0.0',
					isDirect: true,
					depType: 'prod',
					updateKind: 'major',
					deprecatedMessage: null,
				},
				{
					workspace: '',
					packageName: 'lodash',
					currentVersion: '4.17.21',
					declaredRange: '^4.17.0',
					wantedVersion: '4.17.21',
					latestVersion: '4.17.21',
					isDirect: true,
					depType: 'prod',
					updateKind: 'none',
					deprecatedMessage: null,
				},
			]
		);

		await harness.service.sendOutdatedDigests(harness.getNow());
		await harness.service.sendOutdatedDigests(harness.getNow());

		expect(harness.provider.sent).toHaveLength(1);
		const message = harness.provider.sent[0]?.message;
		expect(message?.title).toContain('2026-03-01');
		expect(message?.summary).toContain('1 outdated package');
		expect(
			message?.sections.flatMap((section) =>
				section.lines.map((line) => line.text)
			)
		).toEqual(['react: 18.2.0 → 19.0.0 [direct]']);

		// A new day is a new event key.
		harness.setNow(new Date('2026-03-02T08:00:00.000Z'));
		await harness.service.sendOutdatedDigests(harness.getNow());
		expect(harness.provider.sent).toHaveLength(2);
	});
});

/* -------------------------------------------------------------------------- */
/* Secrets at rest                                                            */
/* -------------------------------------------------------------------------- */

describe('channel config sealing', () => {
	test('round-trips through configEnc and never leaks into configPublicJson', async () => {
		const harness = makeHarness();
		const channel = await harness.notifications.channels.create({
			name: 'ops',
			type: 'discord_webhook',
			config: {
				webhookUrl: 'https://discord.com/api/webhooks/1/super-secret',
			},
			configPublic: { host: 'discord.com', webhookId: '1' },
		});

		expect(channel.configEnc).not.toContain('super-secret');
		expect(channel.configPublicJson).not.toContain('super-secret');

		const opened = await harness.notifications.channels.openConfig(channel);
		expect(opened).toEqual({
			webhookUrl: 'https://discord.com/api/webhooks/1/super-secret',
		});

		// The AAD binds the ciphertext to its own row: replaying it under a
		// different channel id must fail closed.
		const other = { ...channel, id: id() };
		await expect(
			harness.notifications.channels.openConfig(other)
		).rejects.toThrow();
	});
});
