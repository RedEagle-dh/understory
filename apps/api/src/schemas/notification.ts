import { t } from '@declarativejs/core';
import type { EventType as EventTypeUnion } from '@workspace/db/schema';
import { Severity } from './common';

/**
 * TypeBox mirrors of the schema enums. Written as literal tuples rather than
 * `ENUM.map(t.Literal)` because TypeBox only infers a union from a *tuple*;
 * mapping an array collapses `Static<>` to `never`. The `satisfies` below is
 * the drift guard that a mapped array would have given for free.
 */
export const NotificationChannelType = t.Union([
	t.Literal('email_resend'),
	t.Literal('discord_webhook'),
	t.Literal('slack_webhook'),
	t.Literal('webhook'),
]);

export const EventType = t.Union([
	t.Literal('new_vulnerabilities'),
	t.Literal('resolved_vulnerabilities'),
	t.Literal('new_major'),
	t.Literal('outdated_digest'),
	t.Literal('pr_opened'),
	t.Literal('pr_merged'),
	t.Literal('scan_failed'),
]);

/** Compile-time proof the literals above cover exactly the schema's enum. */
type EventTypeLiterals = (typeof EventType)['anyOf'][number]['const'];
const _eventTypesMatch: EventTypeLiterals extends EventTypeUnion
	? EventTypeUnion extends EventTypeLiterals
		? true
		: never
	: never = true;
void _eventTypesMatch;

export const DeliveryStatus = t.Union([
	t.Literal('pending'),
	t.Literal('sent'),
	t.Literal('failed'),
	t.Literal('skipped'),
]);

/**
 * What a channel looks like from outside: the sealed config never appears,
 * only the provider's own `publicView` projection of it.
 */
export const ChannelView = t.Object({
	id: t.String(),
	name: t.String(),
	type: NotificationChannelType,
	enabled: t.Boolean(),
	configPublic: t.Record(t.String(), t.Unknown()),
	createdAt: t.Date(),
	updatedAt: t.Date(),
	lastSuccessAt: t.Union([t.Date(), t.Null()]),
	lastError: t.Union([t.String(), t.Null()]),
	lastErrorAt: t.Union([t.Date(), t.Null()]),
});

export const RuleView = t.Object({
	id: t.String(),
	channelId: t.String(),
	/** '' = all projects. */
	projectId: t.String(),
	eventType: EventType,
	minSeverity: t.Union([Severity, t.Null()]),
	enabled: t.Boolean(),
});

export const DeliveryView = t.Object({
	id: t.String(),
	channelId: t.String(),
	projectId: t.Union([t.String(), t.Null()]),
	eventType: EventType,
	eventKey: t.String(),
	status: DeliveryStatus,
	attempts: t.Number(),
	nextAttemptAt: t.Union([t.Date(), t.Null()]),
	sentAt: t.Union([t.Date(), t.Null()]),
	error: t.Union([t.String(), t.Null()]),
	/** Rendered subject, lifted out of `payloadJson` for the deliveries list. */
	title: t.Union([t.String(), t.Null()]),
	createdAt: t.Date(),
});

export const DeliveryResultView = t.Object({
	ok: t.Boolean(),
	retryable: t.Optional(t.Boolean()),
	error: t.Optional(t.String()),
});
