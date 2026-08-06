import { describe, expect, it } from 'bun:test';
import { createMemoryRateLimiter } from '../index';

describe('createMemoryRateLimiter', () => {
	it('allows up to the limit, then denies with retry-after, then resets', async () => {
		let clock = 0;
		const limiter = createMemoryRateLimiter({ now: () => clock });

		const first = await limiter.consume('read', 'user-1', 2, 60);
		const second = await limiter.consume('read', 'user-1', 2, 60);
		const third = await limiter.consume('read', 'user-1', 2, 60);

		expect(first.allowed).toBe(true);
		expect(second.allowed).toBe(true);
		expect(third.allowed).toBe(false);
		expect(third.retryAfterSeconds).toBe(60);

		// A different key has its own window.
		expect((await limiter.consume('read', 'user-2', 2, 60)).allowed).toBe(true);

		// After the window elapses, the counter resets.
		clock += 60_000;
		expect((await limiter.consume('read', 'user-1', 2, 60)).allowed).toBe(true);
	});
});
