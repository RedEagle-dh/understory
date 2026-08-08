import { createHmac } from 'node:crypto';
import { type Static, t } from '@declarativejs/core';
import type {
	NotificationMessage,
	NotificationProviderPort,
} from './port';
import { toWebhookPayload } from './templates/render';

export const WebhookConfigSchema = t.Object({
	url: t.String({ minLength: 8, maxLength: 2000 }),
	/**
	 * Shared secret. When set, every request carries an HMAC-SHA256 of the
	 * exact body so the receiver can prove the call came from this instance.
	 */
	secret: t.Optional(t.String({ minLength: 8, maxLength: 200 })),
	/** Extra static headers, e.g. an API key the receiver expects. */
	headers: t.Optional(
		t.Record(t.String({ maxLength: 100 }), t.String({ maxLength: 500 }))
	),
});

export type WebhookConfig = Static<typeof WebhookConfigSchema>;

/** 2xx is success; these say "this endpoint will never accept us". */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

/** Header names a caller must not be able to override through `headers`. */
const RESERVED_HEADERS = new Set([
	'content-type',
	'content-length',
	'host',
	'x-understory-signature',
	'x-understory-timestamp',
	'x-understory-event',
]);

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readBody(response: Response): Promise<string> {
	try {
		return (await response.text()).trim().slice(0, 200);
	} catch {
		return '';
	}
}

/**
 * `sha256=<hex>` over `<timestamp>.<body>`.
 *
 * The timestamp is inside the signed string, not merely alongside it, so a
 * captured request cannot be replayed later with a fresh timestamp — the
 * receiver can reject anything older than its own tolerance and know the value
 * it is checking was not altered.
 */
export function signWebhookBody(
	secret: string,
	timestamp: string,
	body: string
): string {
	return `sha256=${createHmac('sha256', secret)
		.update(`${timestamp}.${body}`)
		.digest('hex')}`;
}

export interface WebhookProviderOptions {
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

/**
 * Generic outbound webhook — the escape hatch that covers every integration
 * this project will never write an adapter for (PagerDuty, Teams, n8n, a
 * bespoke internal service).
 *
 * The URL is whatever an operator configures, including hosts inside their own
 * network. That is the point on a self-hosted tool, and it is gated behind the
 * `notification: manage` permission, but it does mean this provider can reach
 * anything the container can — treat granting that permission accordingly.
 */
export function createWebhookProvider(
	options: WebhookProviderOptions = {}
): NotificationProviderPort<WebhookConfig> {
	const doFetch = options.fetchImpl ?? fetch;
	const now = options.now ?? (() => new Date());

	return {
		type: 'webhook',
		configSchema: WebhookConfigSchema,
		// The URL itself is not a secret (it is shown in `publicView`), but the
		// shared secret and any custom headers are — an API key is a common
		// thing to put in one.
		secretFields: ['secret', 'headers'],

		publicView(config) {
			let host = '';
			let path = '';
			try {
				const url = new URL(config.url);
				host = url.host;
				path = url.pathname;
			} catch {
				/* stored config predates validation — show what we can */
			}
			return {
				host,
				path,
				signed: config.secret !== undefined,
				customHeaders: Object.keys(config.headers ?? {}).length,
			};
		},

		async send(config, message: NotificationMessage) {
			const timestamp = String(now().getTime());
			const body = JSON.stringify(toWebhookPayload(message, now()));

			const headers: Record<string, string> = {
				'content-type': 'application/json',
				'user-agent': 'understory-webhook/1',
				'x-understory-event': message.event,
				'x-understory-timestamp': timestamp,
			};
			for (const [key, value] of Object.entries(config.headers ?? {})) {
				// Reserved names are dropped rather than merged: letting a
				// config overwrite the signature header would turn an
				// authentication mechanism into a formality.
				if (RESERVED_HEADERS.has(key.toLowerCase())) continue;
				headers[key] = value;
			}
			if (config.secret !== undefined) {
				headers['x-understory-signature'] = signWebhookBody(
					config.secret,
					timestamp,
					body
				);
			}

			let response: Response;
			try {
				response = await doFetch(config.url, {
					method: 'POST',
					headers,
					body,
				});
			} catch (error) {
				return {
					ok: false,
					retryable: true,
					error: `Webhook request failed: ${messageOf(error)}`,
				};
			}

			if (response.ok) return { ok: true };

			if (response.status === 429) {
				const header = response.headers.get('retry-after');
				const seconds = header === null ? Number.NaN : Number(header);
				return {
					ok: false,
					retryable: true,
					error: 'The webhook endpoint rate limited us',
					retryAfterMs: Math.max(
						1000,
						Math.round(
							(Number.isFinite(seconds) ? seconds : 60) * 1000
						)
					),
				};
			}

			const text = await readBody(response);
			return {
				ok: false,
				retryable: !PERMANENT_STATUSES.has(response.status),
				error: `Webhook returned ${response.status}${text === '' ? '' : `: ${text}`}`,
			};
		},
	};
}

export const webhookProvider = createWebhookProvider();
