import { parseDocument } from 'yaml';

export interface YamlParseResult {
	/** `undefined` when the document failed to parse or is not a mapping. */
	json: Record<string, unknown> | undefined;
	warnings: string[];
}

/**
 * Tolerant YAML read for lockfiles.
 *
 * Bun's built-in `Bun.YAML` is not usable here: it rejects plain scalars ending
 * in a colon, and pnpm writes exactly that (`specifier: catalog:`).
 *
 * `parseDocument` rather than `parse` on purpose. `parse` either throws or —
 * with errors muted — hands back a *recovered* value: `packages: [\n - broken`
 * silently becomes `{packages: [['broken']]}`. Reporting a wrong dependency
 * list is worse than reporting none, so a document with any error is refused
 * outright and its errors are surfaced as scan warnings. Warnings alone (an
 * unknown tag, say) are non-fatal and the value is still used.
 */
export function parseYamlMapping(
	content: string,
	label: string
): YamlParseResult {
	const warnings: string[] = [];
	let json: unknown;
	try {
		const document = parseDocument(content, { merge: true });
		if (document.errors.length > 0) {
			return {
				json: undefined,
				warnings: document.errors
					.slice(0, 5)
					.map((error) => `${label}: ${error.message}`),
			};
		}
		for (const warning of document.warnings.slice(0, 5)) {
			warnings.push(`${label}: ${warning.message}`);
		}
		json = document.toJS({ maxAliasCount: 10_000 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { json: undefined, warnings: [`${label}: ${message}`] };
	}
	if (typeof json !== 'object' || json === null || Array.isArray(json)) {
		return {
			json: undefined,
			warnings: [...warnings, `${label}: document is not a mapping`],
		};
	}
	return { json: json as Record<string, unknown>, warnings };
}

/** Narrow an unknown YAML node to a plain mapping, or `undefined`. */
export function asMapping(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/** Narrow an unknown YAML node to a `Record<string, string>`, dropping non-strings. */
export function asStringMap(value: unknown): Record<string, string> {
	const mapping = asMapping(value);
	if (mapping === undefined) return {};
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(mapping)) {
		if (typeof entry === 'string') out[key] = entry;
		else if (typeof entry === 'number') out[key] = String(entry);
	}
	return out;
}
