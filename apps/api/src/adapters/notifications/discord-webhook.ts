import { type Static, t } from '@declarativejs/core';
import type {
	DeliveryResult,
	NotificationMessage,
	NotificationProviderPort,
} from './port';
import { toDiscordEmbeds } from './templates/render';

export const DiscordWebhookConfigSchema = t.Object({
	webhookUrl: t.String({ minLength: 10, maxLength: 500 }),
	/** Optional prefix content, e.g. `<@&1234>` or `@here`. */
	mention: t.Optional(t.String({ maxLength: 100 })),
});

export type DiscordWebhookConfig = Static<typeof DiscordWebhookConfigSchema>;

/** 401/403/404 all mean the webhook is gone or the token is wrong — never retry. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404]);

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readBody(response: Response): Promise<string> {
	try {
		return (await response.text()).slice(0, 500);
	} catch {
		return '';
	}
}

/**
 * `retry_after` arrives in SECONDS and may be fractional (`0.75`); Discord
 * also mirrors it in the `retry-after` header. Prefer the body, fall back to
 * the header, then to a conservative minute.
 */
async function rateLimitResult(response: Response): Promise<DeliveryResult> {
	let retryAfterSeconds: number | undefined;
	try {
		const body = (await response.json()) as { retry_after?: unknown };
		if (typeof body.retry_after === 'number') {
			retryAfterSeconds = body.retry_after;
		}
	} catch {
		/* non-JSON body — fall through to the header */
	}
	if (retryAfterSeconds === undefined) {
		const header = response.headers.get('retry-after');
		const parsed = header === null ? Number.NaN : Number(header);
		if (Number.isFinite(parsed)) retryAfterSeconds = parsed;
	}
	return {
		ok: false,
		retryable: true,
		error: 'Discord rate limited the webhook',
		retryAfterMs: Math.max(
			1000,
			Math.round((retryAfterSeconds ?? 60) * 1000)
		),
	};
}

export interface DiscordWebhookProviderOptions {
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

/**
 * Discord incoming webhook. The whole surface is one POST; `verify()` is a GET
 * of the same URL, which Discord answers with the webhook's metadata without
 * posting anything to the channel.
 */
export function createDiscordWebhookProvider(
	options: DiscordWebhookProviderOptions = {}
): NotificationProviderPort<DiscordWebhookConfig> {
	const doFetch = options.fetchImpl ?? fetch;
	const now = options.now ?? (() => new Date());

	return {
		type: 'discord_webhook',
		configSchema: DiscordWebhookConfigSchema,
		secretFields: ['webhookUrl'],

		publicView(config) {
			// The path is `/api/webhooks/<id>/<token>`: the id is safe to show,
			// the token never leaves `configEnc`.
			let host = 'discord.com';
			let webhookId = '';
			try {
				const url = new URL(config.webhookUrl);
				host = url.host;
				const segments = url.pathname.split('/').filter(Boolean);
				webhookId = segments.at(-2) ?? '';
			} catch {
				/* stored config predates validation — show what we can */
			}
			return {
				host,
				webhookId,
				...(config.mention === undefined
					? {}
					: { mention: config.mention }),
			};
		},

		async send(config, message: NotificationMessage) {
			const payload = {
				...(config.mention === undefined
					? {}
					: { content: config.mention }),
				embeds: toDiscordEmbeds(message, now()),
			};

			let response: Response;
			try {
				response = await doFetch(config.webhookUrl, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				});
			} catch (error) {
				return {
					ok: false,
					retryable: true,
					error: `Discord webhook request failed: ${messageOf(error)}`,
				};
			}

			if (response.status === 429) return rateLimitResult(response);
			if (response.ok) return { ok: true };
			const body = await readBody(response);
			return {
				ok: false,
				retryable: !PERMANENT_STATUSES.has(response.status),
				error: `Discord webhook returned ${response.status}: ${body}`,
			};
		},

		async verify(config) {
			let response: Response;
			try {
				response = await doFetch(config.webhookUrl, { method: 'GET' });
			} catch (error) {
				return {
					ok: false,
					retryable: true,
					error: `Discord webhook request failed: ${messageOf(error)}`,
				};
			}
			if (response.ok) return { ok: true };
			if (response.status === 429) return rateLimitResult(response);
			const body = await readBody(response);
			return {
				ok: false,
				retryable: !PERMANENT_STATUSES.has(response.status),
				error: `Discord webhook returned ${response.status}: ${body}`,
			};
		},
	};
}

export const discordWebhookProvider = createDiscordWebhookProvider();
