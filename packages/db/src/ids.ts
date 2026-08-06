/**
 * Application-level primary key generator: a 22-character base62 string
 * drawn from `crypto.getRandomValues`. 22 base62 characters is ~131 bits of
 * entropy — comparable to a UUIDv4 (122 bits) — with no external dependency
 * (no nanoid).
 *
 * All `text` primary keys in the schema are filled by the application via
 * this function (the two `integer(...).primaryKey({ autoIncrement: true })`
 * exceptions are documented at their table definitions).
 */

const ALPHABET =
	'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ALPHABET_LENGTH = ALPHABET.length; // 62

// Rejection-sampling threshold: the largest multiple of ALPHABET_LENGTH that
// fits in a byte (256). Bytes >= this are discarded so every kept byte maps
// to an alphabet index with perfectly uniform probability (no modulo bias).
const MAX_UNBIASED_BYTE = 256 - (256 % ALPHABET_LENGTH);

const ID_LENGTH = 22;

export function id(): string {
	let result = '';
	// Over-provision the random buffer so the common case needs only one
	// crypto.getRandomValues call even after rejecting out-of-range bytes.
	const buffer = new Uint8Array(ID_LENGTH * 2);

	while (result.length < ID_LENGTH) {
		crypto.getRandomValues(buffer);
		for (let i = 0; i < buffer.length && result.length < ID_LENGTH; i++) {
			const byte = buffer[i];
			if (byte !== undefined && byte < MAX_UNBIASED_BYTE) {
				result += ALPHABET[byte % ALPHABET_LENGTH];
			}
		}
	}

	return result;
}
