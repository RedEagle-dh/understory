import { describe, expect, it } from 'bun:test';
import { createMemoryCache } from '../index';

describe('createMemoryCache', () => {
	it('stores, reads, expires and invalidates by namespace', async () => {
		let clock = 1_000;
		const cache = createMemoryCache({ now: () => clock });

		await cache.set('notes', 'a', { id: 'a' }, 60);
		expect(await cache.get('notes', 'a')).toEqual({ id: 'a' });

		// TTL expiry.
		clock += 61_000;
		expect(await cache.get('notes', 'a')).toBeUndefined();

		// Namespace invalidation drops everything at once.
		await cache.set('notes', 'b', 1, 60);
		await cache.set('notes', 'c', 2, 60);
		await cache.invalidateNamespace('notes');
		expect(await cache.get('notes', 'b')).toBeUndefined();
		expect(await cache.get('notes', 'c')).toBeUndefined();
	});
});
