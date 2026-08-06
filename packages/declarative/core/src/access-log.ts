import type {
	AccessLogEntry,
	AccessLogPort,
	EventPublisherPort,
	LoggerPort,
} from './ports';

export interface PublishingAccessLogOptions {
	readonly log: LoggerPort;
	/** Broker subject the entries are published to. */
	readonly subject: string;
	/** Entries buffered before `bind()`; beyond it the oldest are dropped. */
	readonly maxBuffer?: number;
}

export interface PublishingAccessLog {
	readonly port: AccessLogPort;
	/** Attaches the publisher once the broker is up and flushes the buffer. */
	readonly bind: (publisher: EventPublisherPort) => void;
}

/**
 * AccessLogPort over an EventPublisherPort (ADR-0010: entries go to the
 * broker, never into a synchronous write). The publisher usually becomes
 * available only after async startup, so entries buffer until `bind()` —
 * bounded, dropping the oldest, because the access log must never take
 * down request serving. Publish failures are logged and swallowed for the
 * same reason.
 */
export function createPublishingAccessLog(
	options: PublishingAccessLogOptions
): PublishingAccessLog {
	const { log, subject } = options;
	const maxBuffer = options.maxBuffer ?? 1000;
	const buffer: AccessLogEntry[] = [];
	let publisher: EventPublisherPort | null = null;
	let dropped = 0;

	const publish = (entry: AccessLogEntry, to: EventPublisherPort): void => {
		to.publish(subject, entry).catch((error: unknown) => {
			log.warn('access log publish failed', {
				subject,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	};

	return {
		port: {
			record(entry) {
				if (publisher !== null) {
					publish(entry, publisher);
					return;
				}
				if (buffer.length >= maxBuffer) {
					buffer.shift();
					dropped += 1;
				}
				buffer.push(entry);
			},
		},
		bind(bound) {
			publisher = bound;
			if (dropped > 0) {
				log.warn(
					'access log entries dropped before the broker was ready',
					{
						dropped,
					}
				);
			}
			for (const entry of buffer.splice(0)) publish(entry, bound);
		},
	};
}
