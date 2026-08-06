import type { LoggerPort } from '@declarativejs/core';
import type { Severity } from '@workspace/audit-engine';
import type { schema } from '@workspace/db';
import type {
	NotificationMessage,
	NotificationProviderPort,
	NotificationProviderType,
} from '../adapters/notifications/port';
import { providers as defaultProviders } from '../adapters/notifications/registry';
import { buildNewMajorMessage } from '../adapters/notifications/templates/new-major';
import { buildNewVulnerabilitiesMessage } from '../adapters/notifications/templates/new-vulnerabilities';
import {
	buildOutdatedDigestMessage,
	type OutdatedDigestItem,
} from '../adapters/notifications/templates/outdated-digest';
import { buildPrMergedMessage } from '../adapters/notifications/templates/pr-merged';
import {
	buildPrOpenedMessage,
	type PullRequestBumpSummary,
} from '../adapters/notifications/templates/pr-opened';
import { buildResolvedVulnerabilitiesMessage } from '../adapters/notifications/templates/resolved-vulnerabilities';
import { buildScanFailedMessage } from '../adapters/notifications/templates/scan-failed';
import type { DependencyStatusStore } from '../stores/dependency-status';
import type {
	NotificationChannelRow,
	NotificationDeliveryRow,
	NotificationsStore,
	RuleWithChannel,
} from '../stores/notifications';
import type { ProjectsStore } from '../stores/projects';
import type {
	ScanDiffEvent,
	ScanDiffFinding,
	ScanDiffMajor,
	ScanFailedEvent,
	ScanNotifierPort,
} from './ports';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/** 1m, 2m, 8m, 30m, 2h, 6h — then the delivery is abandoned. */
const BACKOFF_MS = [
	60_000, 120_000, 480_000, 1_800_000, 7_200_000, 21_600_000,
] as const;
export const MAX_DELIVERY_ATTEMPTS = BACKOFF_MS.length;

/** Retry batch ceiling — a stuck channel must not monopolise a 5-minute job. */
const RETRY_BATCH = 100;
/** Rows listed in a daily digest before it collapses into "+N more". */
const DIGEST_ITEM_LIMIT = 100;

const SEVERITY_RANK: Record<Severity, number> = {
	low: 0,
	moderate: 1,
	high: 2,
	critical: 3,
};

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

interface ProjectScoped {
	projectId: string;
	projectName: string;
}

export interface NewVulnerabilitiesEvent extends ProjectScoped {
	type: 'new_vulnerabilities';
	scanId: string;
	findings: readonly ScanDiffFinding[];
}

export interface ResolvedVulnerabilitiesEvent extends ProjectScoped {
	type: 'resolved_vulnerabilities';
	scanId: string;
	findings: readonly ScanDiffFinding[];
}

export interface NewMajorEvent extends ProjectScoped {
	type: 'new_major';
	scanId: string;
	majors: readonly ScanDiffMajor[];
}

export interface OutdatedDigestEvent extends ProjectScoped {
	type: 'outdated_digest';
	/** `YYYY-MM-DD` (UTC) — the dedupe dimension: one digest per day. */
	day: string;
	items: readonly OutdatedDigestItem[];
	total: number;
}

export interface PrOpenedEvent extends ProjectScoped {
	type: 'pr_opened';
	pullRequestId: string;
	number: number;
	title: string;
	url: string;
	branch: string;
	kind: schema.PullRequestKind;
	bumps: readonly PullRequestBumpSummary[];
}

export interface PrMergedEvent extends Omit<PrOpenedEvent, 'type'> {
	type: 'pr_merged';
}

export interface ScanFailedNotificationEvent extends ProjectScoped {
	type: 'scan_failed';
	scanId: string;
	errorCode: string;
	errorMessage: string;
	/** The streak length that triggered this (1 | 3 | 10) — part of the dedupe key. */
	failureBucket: number;
}

export type NotificationEvent =
	| NewVulnerabilitiesEvent
	| ResolvedVulnerabilitiesEvent
	| NewMajorEvent
	| OutdatedDigestEvent
	| PrOpenedEvent
	| PrMergedEvent
	| ScanFailedNotificationEvent;

/* -------------------------------------------------------------------------- */
/* Event key                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `${eventType}:${projectId}:${sha256(sorted identity).slice(0,16)}`.
 *
 * The identity is the set of things the message is ABOUT, not its rendering:
 * finding ids for vulnerability events, the PR id for PR events, the day for a
 * digest, `${projectId}:${errorCode}:${bucket}` for a failure. Two dispatches
 * of the same logical event therefore compute the same key, and the unique
 * index on `(channelId, eventKey)` turns the second one into a no-op.
 */
export function eventIdentity(event: NotificationEvent): string[] {
	switch (event.type) {
		case 'new_vulnerabilities':
		case 'resolved_vulnerabilities':
			return event.findings.map((finding) => finding.findingId);
		case 'new_major':
			return event.majors.map(
				(major) =>
					`${major.workspace}|${major.packageName}|${major.latestVersion ?? ''}`
			);
		case 'outdated_digest':
			return [event.day];
		case 'pr_opened':
		case 'pr_merged':
			return [event.pullRequestId];
		case 'scan_failed':
			return [
				`${event.projectId}:${event.errorCode}:${event.failureBucket}`,
			];
	}
}

export function computeEventKey(event: NotificationEvent): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update([...eventIdentity(event)].sort().join('\n'));
	return `${event.type}:${event.projectId}:${hasher.digest('hex').slice(0, 16)}`;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export interface NotificationServiceDeps {
	notifications: NotificationsStore;
	projects: ProjectsStore;
	dependencyStatus: DependencyStatusStore;
	/** Base URL for deep links (env.APP_URL). */
	baseUrl: string;
	providers?: Record<NotificationProviderType, NotificationProviderPort>;
	log?: LoggerPort;
	now?: () => Date;
}

export function createNotificationService(deps: NotificationServiceDeps) {
	const store = deps.notifications;
	const providers = deps.providers ?? defaultProviders;
	const log = deps.log;
	const clock = deps.now ?? (() => new Date());

	/**
	 * `minSeverity` filters the ITEMS of a message, not the message as a whole
	 * — a rule set to `high` on a scan that found one critical and twelve low
	 * findings should mail one line, not thirteen. Only vulnerability events
	 * carry per-item severity; the others pass through untouched (a PR or a
	 * scan failure has nothing meaningful to filter).
	 */
	function applySeverityFilter(
		event: NotificationEvent,
		minSeverity: string | null
	): NotificationEvent | null {
		if (minSeverity === null || !(minSeverity in SEVERITY_RANK)) {
			return event;
		}
		const threshold = SEVERITY_RANK[minSeverity as Severity];
		if (
			event.type !== 'new_vulnerabilities' &&
			event.type !== 'resolved_vulnerabilities'
		) {
			return event;
		}
		const findings = event.findings.filter(
			(finding) => SEVERITY_RANK[finding.severity] >= threshold
		);
		if (findings.length === 0) return null;
		return { ...event, findings };
	}

	function renderMessage(event: NotificationEvent): NotificationMessage {
		const baseUrl = deps.baseUrl;
		switch (event.type) {
			case 'new_vulnerabilities':
				return buildNewVulnerabilitiesMessage({ ...event, baseUrl });
			case 'resolved_vulnerabilities':
				return buildResolvedVulnerabilitiesMessage({
					...event,
					baseUrl,
				});
			case 'new_major':
				return buildNewMajorMessage({ ...event, baseUrl });
			case 'outdated_digest':
				return buildOutdatedDigestMessage({ ...event, baseUrl });
			case 'pr_opened':
				return buildPrOpenedMessage({ ...event, baseUrl });
			case 'pr_merged':
				return buildPrMergedMessage({ ...event, baseUrl });
			case 'scan_failed':
				return buildScanFailedMessage({ ...event, baseUrl });
		}
	}

	/**
	 * One delivery per channel. A channel can match twice (a global rule AND a
	 * project rule); the project-scoped rule wins because it is the more
	 * specific statement of intent.
	 */
	function pickRulePerChannel(
		matches: readonly RuleWithChannel[]
	): RuleWithChannel[] {
		const byChannel = new Map<string, RuleWithChannel>();
		for (const match of matches) {
			const current = byChannel.get(match.channel.id);
			if (
				current === undefined ||
				(current.rule.projectId === '' && match.rule.projectId !== '')
			) {
				byChannel.set(match.channel.id, match);
			}
		}
		return [...byChannel.values()];
	}

	/** Sends, then records the outcome on both the delivery and the channel. */
	async function deliver(
		delivery: NotificationDeliveryRow,
		channel: NotificationChannelRow,
		message: NotificationMessage
	): Promise<void> {
		const provider = providers[channel.type];
		const now = clock();

		let result: Awaited<ReturnType<NotificationProviderPort['send']>>;
		try {
			const config = await store.channels.openConfig(channel);
			result = await provider.send(config, message);
		} catch (error) {
			result = {
				ok: false,
				retryable: false,
				error:
					error instanceof Error
						? `provider threw: ${error.message}`
						: `provider threw: ${String(error)}`,
			};
		}

		if (result.ok) {
			await store.deliveries.markSent(delivery.id, now);
			await store.channels.markSuccess(channel.id, now);
			return;
		}

		const attempts = delivery.attempts + 1;
		const willRetry = result.retryable && attempts < MAX_DELIVERY_ATTEMPTS;
		const backoff =
			result.retryAfterMs ?? BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[0];
		await store.deliveries.markFailed(delivery.id, {
			attempts,
			nextAttemptAt: willRetry ? new Date(now.getTime() + backoff) : null,
			error: result.error,
		});
		await store.channels.markError(channel.id, result.error, now);
		log?.warn('notification delivery failed', {
			deliveryId: delivery.id,
			channelId: channel.id,
			attempts,
			retryable: result.retryable,
			willRetry,
			error: result.error,
		});
	}

	async function dispatchEvent(event: NotificationEvent): Promise<void> {
		const matches = await store.rules.matching(event.type, event.projectId);
		if (matches.length === 0) return;

		const eventKey = computeEventKey(event);

		for (const { rule, channel } of pickRulePerChannel(matches)) {
			const scoped = applySeverityFilter(event, rule.minSeverity);
			if (scoped === null) continue;

			const message = renderMessage(scoped);
			// Claim BEFORE sending: the unique index is the only thing standing
			// between a retried scan and a duplicate email.
			const delivery = await store.deliveries.tryInsert({
				channelId: channel.id,
				eventKey,
				eventType: event.type,
				projectId: event.projectId,
				payloadJson: JSON.stringify(message),
			});
			if (delivery === null) continue;

			await deliver(delivery, channel, message);
		}
	}

	/**
	 * Drains the retry queue using the payload persisted at first attempt, so a
	 * retry re-sends exactly what was rendered then — no re-querying findings
	 * that may since have been resolved.
	 */
	async function retryFailed(
		now: Date
	): Promise<{ retried: number; sent: number; skipped: number }> {
		const due = await store.deliveries.listPendingRetries(
			now,
			MAX_DELIVERY_ATTEMPTS,
			RETRY_BATCH
		);
		let sent = 0;
		let skipped = 0;

		for (const delivery of due) {
			const channel = await store.channels.get(delivery.channelId);
			if (channel === null || !channel.enabled) {
				await store.deliveries.markSkipped(
					delivery.id,
					'channel missing or disabled'
				);
				skipped += 1;
				continue;
			}
			if (delivery.payloadJson === null) {
				await store.deliveries.markSkipped(
					delivery.id,
					'no stored payload'
				);
				skipped += 1;
				continue;
			}
			let message: NotificationMessage;
			try {
				message = JSON.parse(
					delivery.payloadJson
				) as NotificationMessage;
			} catch {
				await store.deliveries.markSkipped(
					delivery.id,
					'stored payload is not valid JSON'
				);
				skipped += 1;
				continue;
			}

			await deliver(delivery, channel, message);
			const after = await store.deliveries.byId(delivery.id);
			if (after?.status === 'sent') sent += 1;
		}

		return { retried: due.length, sent, skipped };
	}

	/** `YYYY-MM-DD` in UTC — the digest's dedupe dimension. */
	function dayKey(now: Date): string {
		return now.toISOString().slice(0, 10);
	}

	async function sendOutdatedDigests(
		now: Date = clock()
	): Promise<{ projects: number }> {
		const rules = await store.rules.enabledForEvent('outdated_digest');
		if (rules.length === 0) return { projects: 0 };

		const global = rules.some((match) => match.rule.projectId === '');
		const scopedIds = new Set(
			rules
				.map((match) => match.rule.projectId)
				.filter((projectId) => projectId !== '')
		);

		const allProjects = await deps.projects.list();
		const targets = global
			? allProjects
			: allProjects.filter((project) => scopedIds.has(project.id));

		const day = dayKey(now);
		for (const project of targets) {
			const outdated = await deps.dependencyStatus.listForProject(
				project.id,
				{
					updateKind: ['patch', 'minor', 'major'],
					page: 1,
					pageSize: DIGEST_ITEM_LIMIT,
				}
			);
			if (outdated.total === 0) continue;

			await dispatchEvent({
				type: 'outdated_digest',
				projectId: project.id,
				projectName: project.name,
				day,
				total: outdated.total,
				items: outdated.items.map(
					(row): OutdatedDigestItem => ({
						packageName: row.packageName,
						workspace: row.workspace,
						currentVersion: row.currentVersion,
						latestVersion: row.latestVersion,
						updateKind: row.updateKind,
						isDirect: row.isDirect,
					})
				),
			});
		}

		return { projects: targets.length };
	}

	/** The `ScanNotifierPort` face the scan service holds. */
	const notifier: ScanNotifierPort = {
		async scanDiff(diff: ScanDiffEvent) {
			if (diff.newFindings.length > 0) {
				await dispatchEvent({
					type: 'new_vulnerabilities',
					projectId: diff.projectId,
					projectName: diff.projectName,
					scanId: diff.scanId,
					findings: diff.newFindings,
				});
			}
			if (diff.resolvedFindings.length > 0) {
				await dispatchEvent({
					type: 'resolved_vulnerabilities',
					projectId: diff.projectId,
					projectName: diff.projectName,
					scanId: diff.scanId,
					findings: diff.resolvedFindings,
				});
			}
			if (diff.newMajors.length > 0) {
				// Opt-in per project: most teams do not want a mail every time
				// any transitive dependency ships a major.
				const project = await deps.projects.get(diff.projectId);
				if (project?.notifyOnNewMajor === true) {
					await dispatchEvent({
						type: 'new_major',
						projectId: diff.projectId,
						projectName: diff.projectName,
						scanId: diff.scanId,
						majors: diff.newMajors,
					});
				}
			}
		},

		async scanFailed(event: ScanFailedEvent) {
			await dispatchEvent({
				type: 'scan_failed',
				projectId: event.projectId,
				projectName: event.projectName,
				scanId: event.scanId,
				errorCode: event.errorCode,
				errorMessage: event.errorMessage,
				failureBucket: event.consecutiveFailures,
			});
		},
	};

	return {
		dispatchEvent,
		retryFailed,
		sendOutdatedDigests,
		renderMessage,
		notifier,
		/** Used by `channels.test` when a provider has no `verify()`. */
		async sendDirect(
			channel: NotificationChannelRow,
			message: NotificationMessage
		) {
			const provider = providers[channel.type];
			const config = await store.channels.openConfig(channel);
			return provider.send(config, message);
		},
	};
}

export type NotificationService = ReturnType<typeof createNotificationService>;
