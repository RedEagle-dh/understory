import type { RateLimitDecision, RateLimiterPort } from '@declarativejs/core';

interface Window {
	count: number;
	resetAt: number;
}

export interface MemoryRateLimiterOptions {
	readonly now?: () => number;
}

/**
 * An in-memory fixed-window RateLimiterPort. Fails OPEN is not applicable (the
 * store cannot error), but the contract matches the Redis limiter so
 * `createRateLimitStage` is agnostic. Swap a Redis adapter for multi-instance.
 */
export function createMemoryRateLimiter(
	options: MemoryRateLimiterOptions = {}
): RateLimiterPort {
	const now = options.now ?? (() => Date.now());
	const windows = new Map<string, Window>();

	return {
		consume(bucket, key, limit, windowSeconds): Promise<RateLimitDecision> {
			const id = `${bucket}:${key}`;
			const at = now();
			let window = windows.get(id);
			if (window === undefined || window.resetAt <= at) {
				window = { count: 0, resetAt: at + windowSeconds * 1000 };
				windows.set(id, window);
			}
			window.count += 1;
			if (window.count > limit) {
				return Promise.resolve({
					allowed: false,
					retryAfterSeconds: Math.ceil((window.resetAt - at) / 1000),
				});
			}
			return Promise.resolve({ allowed: true });
		},
	};
}
