import type { TSchema } from '@declarativejs/core';
import type { Severity } from '@workspace/audit-engine';
import type { EventType } from '@workspace/db/schema';

/**
 * The provider-agnostic message model. Templates build one of these from a
 * domain payload; each provider renders it natively (HTML for email, embeds
 * for Discord). Adding an event type is one template file; adding a provider
 * is one file plus a registry entry — neither touches the dispatcher.
 */
export interface NotificationMessage {
	event: EventType;
	projectId?: string;
	projectName?: string;
	/** Subject line / embed title. */
	title: string;
	/** Deep link into the web UI. */
	url?: string;
	/** Drives the embed colour and the HTML accent. */
	severity?: Severity;
	/** One-line plain-text précis, used as the preview / description head. */
	summary: string;
	sections: NotificationSection[];
	footer?: string;
}

export interface NotificationSection {
	heading?: string;
	lines: NotificationLine[];
}

export interface NotificationLine {
	text: string;
	url?: string;
	severity?: Severity;
}

export type DeliveryResult =
	| { ok: true }
	| {
			ok: false;
			retryable: boolean;
			error: string;
			/** Provider-supplied cooldown (Discord `retry_after`, HTTP 429). */
			retryAfterMs?: number;
	  };

export type NotificationProviderType = 'email_resend' | 'discord_webhook';

export interface NotificationProviderPort<Config = unknown> {
	readonly type: NotificationProviderType;
	/** TypeBox schema the channel config is validated against on create/update. */
	readonly configSchema: TSchema;
	/** Keys sealed at rest, redacted from `publicView`, and preserved on partial update. */
	readonly secretFields: readonly string[];
	publicView(config: Config): Record<string, unknown>;
	send(config: Config, message: NotificationMessage): Promise<DeliveryResult>;
	/** Cheap credential check powering `channels.test` without sending anything. */
	verify?(config: Config): Promise<DeliveryResult>;
}
