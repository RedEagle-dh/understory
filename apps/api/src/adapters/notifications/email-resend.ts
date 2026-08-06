import { type Static, t } from '@declarativejs/core';
import { Resend } from 'resend';
import type {
	DeliveryResult,
	NotificationMessage,
	NotificationProviderPort,
} from './port';
import { toHtml, toPlainText } from './templates/render';

export const EmailResendConfigSchema = t.Object({
	apiKey: t.String({ minLength: 1, maxLength: 400 }),
	from: t.String({ minLength: 3, maxLength: 320 }),
	to: t.Array(t.String({ minLength: 3, maxLength: 320 }), {
		minItems: 1,
		maxItems: 20,
	}),
});

export type EmailResendConfig = Static<typeof EmailResendConfigSchema>;

/** Errors that mean "this key/address will never work" — retrying is pointless. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);

function classify(status: number | null, message: string): DeliveryResult {
	if (status === 429) {
		return {
			ok: false,
			retryable: true,
			error: `Resend rate limited: ${message}`,
			retryAfterMs: 60_000,
		};
	}
	if (status !== null && PERMANENT_STATUSES.has(status)) {
		return {
			ok: false,
			retryable: false,
			error: `Resend rejected the request (${status}): ${message}`,
		};
	}
	// 5xx, null status (network / DNS / abort) — transient by assumption.
	return {
		ok: false,
		retryable: true,
		error: `Resend request failed${status === null ? '' : ` (${status})`}: ${message}`,
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface EmailResendProviderOptions {
	/** Swappable for tests; production uses the real SDK. */
	clientFactory?: (apiKey: string) => Pick<Resend, 'emails' | 'apiKeys'>;
}

/**
 * Resend-backed email. `verify()` deliberately does NOT send: listing API keys
 * is a read-only call that distinguishes "bad key" (401/403) from "reachable"
 * without putting a test mail in anyone's inbox.
 */
export function createEmailResendProvider(
	options: EmailResendProviderOptions = {}
): NotificationProviderPort<EmailResendConfig> {
	const clientFactory =
		options.clientFactory ?? ((apiKey: string) => new Resend(apiKey));

	return {
		type: 'email_resend',
		configSchema: EmailResendConfigSchema,
		secretFields: ['apiKey'],

		publicView(config) {
			return { from: config.from, to: config.to };
		},

		async send(config, message: NotificationMessage) {
			try {
				const result = await clientFactory(config.apiKey).emails.send({
					from: config.from,
					to: config.to,
					subject: message.title,
					html: toHtml(message),
					text: toPlainText(message),
				});
				if (result.error !== null) {
					return classify(
						result.error.statusCode,
						result.error.message
					);
				}
				return { ok: true };
			} catch (error) {
				return classify(null, messageOf(error));
			}
		},

		async verify(config) {
			try {
				const result = await clientFactory(
					config.apiKey
				).apiKeys.list();
				if (result.error !== null) {
					// A send-only restricted key authenticates fine but may not
					// list keys — that is a scope answer, not a bad credential.
					if (result.error.name === 'restricted_api_key') {
						return { ok: true };
					}
					return classify(
						result.error.statusCode,
						result.error.message
					);
				}
				return { ok: true };
			} catch (error) {
				return classify(null, messageOf(error));
			}
		},
	};
}

export const emailResendProvider = createEmailResendProvider();
