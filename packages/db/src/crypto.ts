/**
 * AES-256-GCM "sealed secret" helpers, used to encrypt things like GitHub
 * tokens and notification-channel credentials before they touch SQLite.
 *
 * Pure WebCrypto (`crypto.subtle`) — no `node:crypto` import, so this works
 * identically under Bun and in tests.
 *
 * Sealed format: `v1.<base64url iv>.<base64url ciphertext+tag>`
 * - `iv` is a fresh random 12-byte nonce per call to `seal`.
 * - AES-GCM's `encrypt()` output already appends the 16-byte auth tag to the
 *   ciphertext, so "ciphertext+tag" falls out of WebCrypto for free.
 * - `aad` (additional authenticated data) is bound into the tag but never
 *   stored — callers must supply the same `aad` to `open` (e.g. the owning
 *   row's id), which prevents a sealed value from being copy-pasted onto a
 *   different row undetected.
 */

const FORMAT_VERSION = 'v1';
const IV_BYTE_LENGTH = 12;
const AES_KEY_BYTE_LENGTH = 32; // AES-256

export class SecretOpenError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'SecretOpenError';
	}
}

export interface SecretBox {
	seal(plaintext: string, aad: string): Promise<string>;
	open(sealed: string, aad: string): Promise<string>;
}

export interface SecretBoxKeys {
	/** Base64-encoded 32-byte AES-256 key used to seal new values and tried first when opening. */
	current: string;
	/** Base64-encoded 32-byte AES-256 key, retained during key rotation so old sealed values still open. */
	previous?: string;
}

function decodeBase64(label: string, base64: string): Uint8Array<ArrayBuffer> {
	if (!base64) {
		throw new Error(
			`Missing ${label} encryption key. Generate one with \`openssl rand -base64 32\` and set it as the ${label} key.`
		);
	}
	let binary: string;
	try {
		binary = atob(base64);
	} catch (cause) {
		throw new Error(
			`Invalid ${label} encryption key: not valid base64. Generate one with \`openssl rand -base64 32\`.`,
			{ cause }
		);
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	if (bytes.length !== AES_KEY_BYTE_LENGTH) {
		throw new Error(
			`Invalid ${label} encryption key: expected ${AES_KEY_BYTE_LENGTH} bytes (AES-256) after base64 decoding, got ${bytes.length}. Generate one with \`openssl rand -base64 32\`.`
		);
	}
	return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * TextEncoder always allocates a fresh ArrayBuffer, but its lib typing widens
 * to ArrayBufferLike — narrow it so WebCrypto's BufferSource accepts it under
 * both the bun and DOM libs.
 */
function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}

function importAesGcmKey(
	rawKeyBytes: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		rawKeyBytes,
		{ name: 'AES-GCM' },
		false,
		['encrypt', 'decrypt']
	);
}

/**
 * Builds a `SecretBox` bound to the given key(s). Throws synchronously if a
 * key is missing, not valid base64, or not exactly 32 bytes — fail fast at
 * boot rather than on the first `seal`/`open` call.
 */
export function createSecretBox(keys: SecretBoxKeys): SecretBox {
	const currentKeyBytes = decodeBase64('current', keys.current);
	const previousKeyBytes =
		keys.previous !== undefined
			? decodeBase64('previous', keys.previous)
			: undefined;

	const currentKeyPromise = importAesGcmKey(currentKeyBytes);
	const previousKeyPromise =
		previousKeyBytes !== undefined
			? importAesGcmKey(previousKeyBytes)
			: undefined;

	async function seal(plaintext: string, aad: string): Promise<string> {
		const key = await currentKeyPromise;
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
		const aadBytes = utf8Bytes(aad);
		const plaintextBytes = utf8Bytes(plaintext);
		const ciphertext = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: aadBytes },
			key,
			plaintextBytes
		);
		return `${FORMAT_VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
	}

	async function tryDecrypt(
		key: CryptoKey,
		iv: Uint8Array<ArrayBuffer>,
		ciphertext: Uint8Array<ArrayBuffer>,
		aadBytes: Uint8Array<ArrayBuffer>
	): Promise<string | undefined> {
		try {
			const plaintextBytes = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv, additionalData: aadBytes },
				key,
				ciphertext
			);
			return new TextDecoder().decode(plaintextBytes);
		} catch {
			return undefined;
		}
	}

	async function open(sealed: string, aad: string): Promise<string> {
		const parts = sealed.split('.');
		if (parts.length !== 3 || parts[0] !== FORMAT_VERSION) {
			throw new SecretOpenError(
				`Unrecognized sealed secret format${parts[0] ? ` (got version "${parts[0]}")` : ''}; expected "${FORMAT_VERSION}".`
			);
		}
		const [, ivPart, ciphertextPart] = parts as [string, string, string];

		let iv: Uint8Array<ArrayBuffer>;
		let ciphertext: Uint8Array<ArrayBuffer>;
		try {
			iv = base64UrlToBytes(ivPart);
			ciphertext = base64UrlToBytes(ciphertextPart);
		} catch (cause) {
			throw new SecretOpenError(
				'Malformed sealed secret: invalid base64url encoding.',
				{ cause }
			);
		}
		if (iv.length !== IV_BYTE_LENGTH) {
			throw new SecretOpenError(
				`Malformed sealed secret: expected a ${IV_BYTE_LENGTH}-byte IV, got ${iv.length}.`
			);
		}

		const aadBytes = utf8Bytes(aad);

		const currentKey = await currentKeyPromise;
		const viaCurrent = await tryDecrypt(
			currentKey,
			iv,
			ciphertext,
			aadBytes
		);
		if (viaCurrent !== undefined) {
			return viaCurrent;
		}

		if (previousKeyPromise !== undefined) {
			const previousKey = await previousKeyPromise;
			const viaPrevious = await tryDecrypt(
				previousKey,
				iv,
				ciphertext,
				aadBytes
			);
			if (viaPrevious !== undefined) {
				return viaPrevious;
			}
		}

		throw new SecretOpenError(
			'Failed to open sealed secret: decryption failed (wrong key, tampered ciphertext, or mismatched AAD).'
		);
	}

	return { seal, open };
}
