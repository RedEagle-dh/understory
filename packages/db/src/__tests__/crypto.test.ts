import { describe, expect, test } from 'bun:test';
import { createSecretBox, SecretOpenError } from '../crypto';

const KEY_A = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
const KEY_B = Buffer.from(new Uint8Array(32).fill(2)).toString('base64');

/**
 * Flips one bit in the *first* byte of a base64url segment and re-encodes.
 * Flipping the trailing character of a base64url string is unreliable as a
 * tamper test: the last character of an unpadded group can encode bits that
 * decode to the same byte value either side of the flip, making such a test
 * flaky. The first byte of any group is always fully significant.
 */
function tamperBase64Url(segment: string): string {
	const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const bytes = Buffer.from(padded, 'base64');
	bytes[0] = (bytes[0] as number) ^ 0xff;
	return bytes
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

describe('createSecretBox', () => {
	test('round-trips seal/open', async () => {
		const box = createSecretBox({ current: KEY_A });
		const sealed = await box.seal('super-secret-token', 'project:abc123');
		expect(sealed.startsWith('v1.')).toBe(true);
		expect(sealed.split('.')).toHaveLength(3);
		const opened = await box.open(sealed, 'project:abc123');
		expect(opened).toBe('super-secret-token');
	});

	test('round-trips an empty-string plaintext', async () => {
		const box = createSecretBox({ current: KEY_A });
		const sealed = await box.seal('', 'aad');
		const opened = await box.open(sealed, 'aad');
		expect(opened).toBe('');
	});

	test('produces a fresh IV (and ciphertext) on every seal call', async () => {
		const box = createSecretBox({ current: KEY_A });
		const first = await box.seal('same-plaintext', 'aad');
		const second = await box.seal('same-plaintext', 'aad');
		expect(first).not.toBe(second);
	});

	test('rejects when opened with the wrong AAD', async () => {
		const box = createSecretBox({ current: KEY_A });
		const sealed = await box.seal('secret', 'project:abc');
		await expect(box.open(sealed, 'project:xyz')).rejects.toThrow(
			SecretOpenError
		);
	});

	test('rejects a tampered ciphertext', async () => {
		const box = createSecretBox({ current: KEY_A });
		const sealed = await box.seal('secret', 'aad');
		const [version, iv, ciphertext] = sealed.split('.') as [
			string,
			string,
			string,
		];
		const tampered = `${version}.${iv}.${tamperBase64Url(ciphertext)}`;
		await expect(box.open(tampered, 'aad')).rejects.toThrow(
			SecretOpenError
		);
	});

	test('rejects a tampered IV', async () => {
		const box = createSecretBox({ current: KEY_A });
		const sealed = await box.seal('secret', 'aad');
		const [version, iv, ciphertext] = sealed.split('.') as [
			string,
			string,
			string,
		];
		const tampered = `${version}.${tamperBase64Url(iv)}.${ciphertext}`;
		await expect(box.open(tampered, 'aad')).rejects.toThrow(
			SecretOpenError
		);
	});

	test('opens values sealed under the previous key during rotation', async () => {
		const oldBox = createSecretBox({ current: KEY_A });
		const sealedWithOldKey = await oldBox.seal('legacy-secret', 'aad');

		const rotatedBox = createSecretBox({ current: KEY_B, previous: KEY_A });
		const opened = await rotatedBox.open(sealedWithOldKey, 'aad');
		expect(opened).toBe('legacy-secret');

		// New seals under the rotated box use the new current key, and are
		// still openable by it.
		const sealedWithNewKey = await rotatedBox.seal('fresh-secret', 'aad');
		expect(await rotatedBox.open(sealedWithNewKey, 'aad')).toBe(
			'fresh-secret'
		);
	});

	test('rejects a value sealed under a key not in {current, previous}', async () => {
		const strangerBox = createSecretBox({ current: KEY_B });
		const sealed = await strangerBox.seal('secret', 'aad');

		const box = createSecretBox({ current: KEY_A });
		await expect(box.open(sealed, 'aad')).rejects.toThrow(SecretOpenError);
	});

	test.each([
		['empty string', ''],
		['missing dots', 'not-a-sealed-value'],
		['unknown format version', 'v2.abc.def'],
		['too many segments', 'v1.abc.def.ghi'],
		['invalid base64url', 'v1.not base64!.also not base64!'],
	])('rejects malformed input: %s', async (_label, malformed) => {
		const box = createSecretBox({ current: KEY_A });
		await expect(box.open(malformed, 'aad')).rejects.toThrow(
			SecretOpenError
		);
	});

	test('throws synchronously at construction when the current key is missing', () => {
		// biome-ignore lint/suspicious/noExplicitAny: intentionally passing an invalid shape
		expect(() => createSecretBox({ current: '' as any })).toThrow();
	});

	test('throws synchronously at construction when the current key is the wrong length', () => {
		const tooShort = Buffer.from(new Uint8Array(16).fill(1)).toString(
			'base64'
		);
		expect(() => createSecretBox({ current: tooShort })).toThrow(
			/32 bytes/
		);
	});

	test('throws synchronously at construction when the previous key is the wrong length', () => {
		const tooShort = Buffer.from(new Uint8Array(16).fill(1)).toString(
			'base64'
		);
		expect(() =>
			createSecretBox({ current: KEY_A, previous: tooShort })
		).toThrow(/32 bytes/);
	});

	test('throws synchronously at construction when the current key is not valid base64', () => {
		expect(() =>
			createSecretBox({ current: '***not base64***' })
		).toThrow();
	});
});
