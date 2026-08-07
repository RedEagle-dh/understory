import { normalizePypiName } from '../pep440';

/**
 * One parsed PEP 508 dependency specifier, e.g.
 * `requests[security]>=2.0,<3; python_version < "3.11"`.
 */
export interface Pep508Requirement {
	/** PEP 503-normalized name. */
	name: string;
	/** Raw name as written. */
	rawName: string;
	extras: string[];
	/** Version specifier portion, e.g. `>=2.0,<3`; `''` when none. */
	specifier: string;
	/** Environment marker after `;`, undefined when none. */
	marker?: string;
	/** Direct reference after `@`, undefined when none. */
	url?: string;
}

/**
 * PEP 508 project name: alphanumeric with inner `.`, `_`, `-`. Anchored so a
 * flag line (`-r other.txt`) or garbage never yields a name.
 */
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/;

/** Every specifier clause starts with an operator (or a wrapping paren). */
const SPECIFIER_START = /^[<>=!~]/;

/**
 * Index of the first `char` outside single/double quotes, or -1. Markers may
 * quote arbitrary strings (`sys_platform == "win;32"`), so a naive
 * `indexOf(';')` would split inside them.
 */
function findUnquoted(text: string, char: string): number {
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const current = text[i] as string;
		if (quote !== null) {
			if (current === quote) quote = null;
			continue;
		}
		if (current === '"' || current === "'") {
			quote = current;
			continue;
		}
		if (current === char) return i;
	}
	return -1;
}

/**
 * Parse a PEP 508 dependency specifier string.
 *
 * Handles bare names (`requests`), extras (`requests[security,socks]`),
 * specifier sets (`>=2.0,<3`), the parenthesized form older metadata and
 * poetry export use (`requests (>=2.0)`), direct references (`pkg @ https://…`)
 * and trailing environment markers (`; python_version < "3.11"`).
 *
 * Returns `null` for empty or unparseable input rather than throwing — the
 * callers surface a warning and move on. Known limitation: a direct-reference
 * URL containing a literal `;` is truncated at it, since the marker separator
 * is found by scanning for the first unquoted `;`.
 */
export function parsePep508(input: string): Pep508Requirement | null {
	let text = input.trim();
	if (text === '') return null;

	let marker: string | undefined;
	const semi = findUnquoted(text, ';');
	if (semi !== -1) {
		const rawMarker = text.slice(semi + 1).trim();
		if (rawMarker !== '') marker = rawMarker;
		text = text.slice(0, semi).trim();
	}

	const nameMatch = NAME.exec(text);
	if (nameMatch === null) return null;
	const rawName = nameMatch[0];
	let rest = text.slice(rawName.length).trim();

	let extras: string[] = [];
	if (rest.startsWith('[')) {
		const close = rest.indexOf(']');
		if (close === -1) return null;
		extras = rest
			.slice(1, close)
			.split(',')
			.map((extra) => extra.trim())
			.filter((extra) => extra !== '');
		rest = rest.slice(close + 1).trim();
	}

	const base = {
		name: normalizePypiName(rawName),
		rawName,
		extras,
	};

	if (rest.startsWith('@')) {
		const url = rest.slice(1).trim();
		if (url === '') return null;
		return { ...base, specifier: '', marker, url };
	}

	let specifier = rest;
	if (specifier.startsWith('(') && specifier.endsWith(')')) {
		specifier = specifier.slice(1, -1).trim();
	}
	if (specifier !== '' && !SPECIFIER_START.test(specifier)) return null;

	return { ...base, specifier, marker };
}
