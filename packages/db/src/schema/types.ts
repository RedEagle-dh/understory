/**
 * String-literal union types shared across the schema, each backed by a
 * `const` array so the array (used for `text(..., { enum })` columns) and
 * the derived TS union type can never drift apart.
 */

export const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** `projects.autoPrMaxBump` — the largest bump kind an auto-PR is allowed to make. */
export const BUMP_KINDS = ['patch', 'minor', 'major'] as const;
export type BumpKind = (typeof BUMP_KINDS)[number];

/** `findings.fixType` — 'none' means no fixed version exists yet. */
export const FIX_TYPES = ['patch', 'minor', 'major', 'none'] as const;
export type FixType = (typeof FIX_TYPES)[number];

/** `dependencyStatus.updateKind` — 'none' means already on latest. */
export const UPDATE_KINDS = ['none', 'patch', 'minor', 'major'] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];

export const SCAN_TRIGGERS = ['schedule', 'manual', 'auto'] as const;
export type ScanTrigger = (typeof SCAN_TRIGGERS)[number];

export const SCAN_STATUSES = ['running', 'ok', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const PACKAGE_MANAGERS = [
	'npm',
	'bun',
	'yarn',
	'pnpm',
	'uv',
	'poetry',
	'pip',
] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** The package registry universe a dependency set / advisory range lives in. */
export const ECOSYSTEMS = ['npm', 'pypi'] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export const DEP_TYPES = [
	'prod',
	'dev',
	'peer',
	'optional',
	'peer_optional',
] as const;
export type DepType = (typeof DEP_TYPES)[number];

export const FINDING_STATES = ['open', 'resolved', 'ignored'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export const PEER_ISSUE_KINDS = ['missing', 'invalid'] as const;
export type PeerIssueKind = (typeof PEER_ISSUE_KINDS)[number];

export const PEER_ISSUE_STATES = ['open', 'resolved'] as const;
export type PeerIssueState = (typeof PEER_ISSUE_STATES)[number];

export const PULL_REQUEST_KINDS = [
	'manual',
	'auto_security',
	'auto_update',
] as const;
export type PullRequestKind = (typeof PULL_REQUEST_KINDS)[number];

export const PULL_REQUEST_STATES = [
	'creating',
	'open',
	'merged',
	'closed',
	'failed',
] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/** `advisorySources.source` — which upstream feed an advisory record came from. */
export const ADVISORY_SOURCES = ['npm', 'osv'] as const;
export type AdvisorySource = (typeof ADVISORY_SOURCES)[number];

export const NOTIFICATION_CHANNEL_TYPES = [
	'email_resend',
	'discord_webhook',
] as const;
export type NotificationChannelType =
	(typeof NOTIFICATION_CHANNEL_TYPES)[number];

export const DELIVERY_STATUSES = [
	'pending',
	'sent',
	'failed',
	'skipped',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const EVENT_TYPES = [
	'new_vulnerabilities',
	'resolved_vulnerabilities',
	'new_major',
	'outdated_digest',
	'pr_opened',
	'pr_merged',
	'scan_failed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
