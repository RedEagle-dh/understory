import {
	normalizePypiName,
	parsePep508,
	parsePyproject,
	parseRequirementsTxt,
	pep440Versioning,
	translatePoetryRange,
} from '@workspace/audit-engine';
import type { RepoFile } from '../adapters/github/repo-reader';
import type {
	DeclarationStyle,
	ManifestDeclaration,
	ManifestIndex,
} from './pr-service';

/**
 * Python manifest editing for the PR pipeline.
 *
 * The npm side gets away with parse-and-reserialize because `JSON.parse` /
 * `JSON.stringify` round-trip a package.json faithfully. TOML does not: no
 * parser preserves comments, key order quirks, or the author's inline-table
 * formatting. So every rewrite here is a targeted SUBSTRING replacement on the
 * original text — the file comes back byte-identical except for the specifier
 * that was meant to change. Anything that cannot be located precisely is
 * reported as not applied, never guessed at.
 *
 * `smol-toml` is not resolvable from this workspace (bun's isolated installs
 * do not hoist the engine's dependencies), so structural questions — "what
 * does this pyproject declare?" — go through the engine's own parsers
 * ({@link parsePyproject} / {@link parseRequirementsTxt}), and the edit
 * strategies below never need a TOML parse at all.
 */

/* -------------------------------------------------------------------------- */
/* Path helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Vendored / virtual-env trees whose manifests are never the project's own. */
const SKIP_SEGMENTS = ['node_modules/', '.venv/', 'site-packages/'];

function isVendoredPath(path: string): boolean {
	return SKIP_SEGMENTS.some((segment) => path.includes(segment));
}

function basenameOf(path: string): string {
	return path.split('/').at(-1) ?? path;
}

function dirnameOf(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

function depthOf(path: string): number {
	return path.split('/').length;
}

/** Shallowest first, then lexicographic — same root rule as the npm index. */
function byDepthThenPath(a: RepoFile, b: RepoFile): number {
	return (
		depthOf(a.path) - depthOf(b.path) ||
		(a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
	);
}

/* -------------------------------------------------------------------------- */
/* Declaration extraction                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A pyproject declaration's style is recoverable from the engine's rows
 * without re-parsing the TOML: a PEP 621 / dependency-group entry's rawRange
 * is a full PEP 508 string, so it parses back to the declaration's own name.
 * A poetry constraint (`^2.0`, `>=2.0,<3`) never does — the PEP 508 name
 * grammar rejects a leading operator, and a bare version parses to the wrong
 * "name". Poetry inline tables arrive as their `JSON.stringify` image.
 */
function pyprojectDeclarations(
	file: RepoFile
): Map<string, ManifestDeclaration> {
	const map = new Map<string, ManifestDeclaration>();
	// Emission order is pep621 → optional-dependencies → dependency-groups →
	// poetry, which is exactly the required search order; first hit wins.
	for (const dep of parsePyproject(file.content).declared) {
		if (map.has(dep.name)) continue;

		const asPep508 = parsePep508(dep.rawRange);
		if (asPep508 !== null && asPep508.name === dep.name) {
			map.set(dep.name, {
				rawRange: dep.rawRange,
				effectiveRange: dep.specifier,
				editPath: file.path,
				missingCatalogEntry: false,
				style: 'pep621',
			});
			continue;
		}

		if (dep.rawRange.startsWith('{') || dep.rawRange.startsWith('[')) {
			// Inline table (or constraint array), serialized by the engine.
			// `{ version = "^2.0", … }` carries an editable constraint;
			// git/path/url tables do not — an empty effectiveRange makes the
			// upstream classification drop them.
			const version = versionOfPoetryTable(dep.rawRange);
			map.set(dep.name, {
				rawRange: version ?? dep.rawRange,
				effectiveRange:
					version === null
						? ''
						: translatePoetryRange(version).specifier,
				editPath: file.path,
				missingCatalogEntry: false,
				style: 'poetry',
			});
			continue;
		}

		// Poetry constraint string; the engine already translated it to a
		// PEP 440 specifier set (`^2.0` → `>=2.0,<3`).
		map.set(dep.name, {
			rawRange: dep.rawRange,
			effectiveRange: dep.specifier,
			editPath: file.path,
			missingCatalogEntry: false,
			style: 'poetry',
		});
	}
	return map;
}

/** The `version` string of a serialized poetry inline table, or null. */
function versionOfPoetryTable(serialized: string): string | null {
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			const version = (parsed as Record<string, unknown>).version;
			if (typeof version === 'string') return version;
		}
	} catch {
		// Not JSON — fall through to null.
	}
	return null;
}

function requirementsDeclarations(
	file: RepoFile
): Map<string, ManifestDeclaration> {
	const map = new Map<string, ManifestDeclaration>();
	for (const dep of parseRequirementsTxt(file.content).declared) {
		if (map.has(dep.name)) continue;
		map.set(dep.name, {
			// The engine's rawRange is the logical line minus comment — the
			// requirement portion as written.
			rawRange: dep.rawRange,
			effectiveRange: dep.specifier,
			editPath: file.path,
			missingCatalogEntry: false,
			style: 'requirements',
		});
	}
	return map;
}

/* -------------------------------------------------------------------------- */
/* Index                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * {@link ManifestIndex} for a Python repository snapshot.
 *
 * Python dependency graphs are flat — neither pip nor poetry has workspaces
 * and uv members are flattened by the scan — so every declaration lives at
 * workspace `''` and `pathForWorkspace` always answers with the root manifest.
 *
 * The root is the shallowest (then lexicographically first) `pyproject.toml`;
 * a pip project prefers the shallowest `requirements.txt` as the edit target
 * for its pins, while a pyproject alongside it is still indexed and searched
 * second. Vendored trees (`node_modules/`, `.venv/`, `site-packages/`) are
 * never the project's own manifests and are skipped outright.
 */
export function buildPypiManifestIndex(
	files: readonly RepoFile[],
	manager: 'uv' | 'poetry' | 'pip'
): ManifestIndex | null {
	const pyprojects = files
		.filter(
			(file) =>
				basenameOf(file.path) === 'pyproject.toml' &&
				!isVendoredPath(file.path)
		)
		.sort(byDepthThenPath);
	const requirements = files
		.filter(
			(file) =>
				basenameOf(file.path) === 'requirements.txt' &&
				!isVendoredPath(file.path)
		)
		.sort(byDepthThenPath);

	const rootPyproject = pyprojects[0];
	const rootRequirements = requirements[0];
	const rootFile =
		manager === 'pip'
			? (rootRequirements ?? rootPyproject)
			: (rootPyproject ?? rootRequirements);
	if (rootFile === undefined) return null;

	const rootDir = dirnameOf(rootFile.path);

	// Search order: a pip project's requirements.txt is authoritative for its
	// pins and is consulted first; otherwise the pyproject is, and a stray
	// requirements.txt only matters when no pyproject exists at all.
	const searchMaps: Map<string, ManifestDeclaration>[] = [];
	if (manager === 'pip') {
		if (rootRequirements !== undefined) {
			searchMaps.push(requirementsDeclarations(rootRequirements));
		}
		if (rootPyproject !== undefined) {
			searchMaps.push(pyprojectDeclarations(rootPyproject));
		}
	} else if (rootPyproject !== undefined) {
		searchMaps.push(pyprojectDeclarations(rootPyproject));
	} else if (rootRequirements !== undefined) {
		searchMaps.push(requirementsDeclarations(rootRequirements));
	}

	const indexed =
		manager === 'pip' ? [...pyprojects, ...requirements] : pyprojects;
	const paths = [
		rootFile.path,
		...indexed
			.map((file) => file.path)
			.filter((path) => path !== rootFile.path),
	];

	return {
		rootPath: rootFile.path,
		// Flat graph: every workspace name resolves to the root manifest.
		pathForWorkspace: () => rootFile.path,
		pathAtRoot(name) {
			return rootDir === '' ? name : `${rootDir}/${name}`;
		},
		manifestPaths: () => [...paths],
		declaration(_workspace, name) {
			const normalized = normalizePypiName(name);
			for (const map of searchMaps) {
				const declaration = map.get(normalized);
				if (declaration !== undefined) return declaration;
			}
			return undefined;
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Text-preserving edits                                                      */
/* -------------------------------------------------------------------------- */

export interface PypiRangeEdit {
	/** PEP 503-normalized name. */
	packageName: string;
	/**
	 * The new specifier in ecosystem syntax — PEP 440 for pep621/requirements
	 * entries, poetry syntax (`^2.1.4`) for poetry entries.
	 */
	newRange: string;
	/** How the declaration is written; picks the rewrite strategy. */
	style: DeclarationStyle;
}

/**
 * Apply range edits to a Python manifest, preserving every byte that is not
 * the specifier being replaced.
 *
 * Strategy per style:
 * - `'pep621'`: rewrite every single-line quoted string in the file that
 *   parses (PEP 508) to the target name. Requirement strings are the only
 *   strings a pyproject uses in that shape, so no section tracking is needed;
 *   name casing, extras text, quote character and marker all survive.
 * - `'poetry'`: rewrite the value of matching `name = …` assignments — plain
 *   strings and inline-table `version` values — but only on lines inside a
 *   `[tool.poetry(.group.<g>)?.(dev-)?dependencies]` section, so a same-named
 *   key elsewhere in the file is never touched.
 * - `'requirements'`: line-based; the specifier portion is replaced while
 *   extras, markers, trailing comments and flag lines stay as written.
 *
 * A package that could not be located precisely is absent from `applied` —
 * never approximated. Every matching occurrence of an edit is rewritten.
 */
export function applyPypiRangeEdits(
	content: string,
	edits: readonly PypiRangeEdit[],
	format: 'pyproject' | 'requirements'
): { content: string; applied: string[] } {
	let current = content;
	const applied: string[] = [];

	for (const edit of edits) {
		const name = normalizePypiName(edit.packageName);
		let result: { content: string; touched: boolean };
		if (format === 'pyproject' && edit.style === 'pep621') {
			result = rewritePep621Strings(current, name, edit.newRange);
		} else if (format === 'pyproject' && edit.style === 'poetry') {
			result = rewritePoetryValues(current, name, edit.newRange);
		} else if (format === 'requirements' && edit.style === 'requirements') {
			result = rewriteRequirementLines(current, name, edit.newRange);
		} else {
			// Style/format mismatch: this edit belongs to a different file.
			continue;
		}
		current = result.content;
		if (result.touched) applied.push(edit.packageName);
	}

	return { content: current, applied };
}

/**
 * Rebuild one requirement's text around a new specifier:
 * `name-as-written + extras-as-written + newRange [+ " ; marker"]`, keeping
 * any leading/trailing whitespace of `text` itself. Returns null when the
 * text does not parse to `expectedName`, is a direct reference (a URL has no
 * specifier to replace), or contains backslashes (an escaped TOML string —
 * the raw source bytes would not round-trip).
 */
function rewriteRequirementText(
	text: string,
	expectedName: string,
	newRange: string
): string | null {
	const lead = /^\s*/.exec(text)?.[0] ?? '';
	const tail = /\s*$/.exec(text.slice(lead.length))?.[0] ?? '';
	const body = text.trim();
	if (body === '' || body.includes('\\')) return null;

	const requirement = parsePep508(body);
	if (
		requirement === null ||
		requirement.name !== expectedName ||
		requirement.url !== undefined
	) {
		return null;
	}

	// The name grammar is anchored, so the trimmed body starts with rawName.
	let prefixEnd = requirement.rawName.length;
	const extras = /^\s*\[[^\]]*\]/.exec(body.slice(prefixEnd));
	if (extras !== null) prefixEnd += extras[0].length;
	const prefix = body.slice(0, prefixEnd);

	const marker =
		requirement.marker === undefined ? '' : ` ; ${requirement.marker}`;
	return `${lead}${prefix}${newRange}${marker}${tail}`;
}

/**
 * pep621 strategy: walk the file's quoted single-line strings and rewrite the
 * ones that parse to the target. Comments are consumed to end-of-line first so
 * an apostrophe in prose never opens a phantom string; triple-quoted strings
 * are skipped whole; a candidate whose rewrite would need the enclosing quote
 * character is left alone rather than corrupted.
 */
function rewritePep621Strings(
	content: string,
	name: string,
	newRange: string
): { content: string; touched: boolean } {
	let out = '';
	let touched = false;
	let i = 0;

	while (i < content.length) {
		const char = content[i] as string;

		if (char === '#') {
			const newline = content.indexOf('\n', i);
			const end = newline === -1 ? content.length : newline;
			out += content.slice(i, end);
			i = end;
			continue;
		}

		if (char !== '"' && char !== "'") {
			out += char;
			i++;
			continue;
		}

		// Multi-line strings never hold a requirement; copy them verbatim.
		const triple = char.repeat(3);
		if (content.startsWith(triple, i)) {
			const close = content.indexOf(triple, i + 3);
			const end = close === -1 ? content.length : close + 3;
			out += content.slice(i, end);
			i = end;
			continue;
		}

		// Find the closing quote on the same line, honoring `\"` escapes in
		// basic strings. An unterminated string is abandoned at the newline.
		let j = i + 1;
		let close = -1;
		while (j < content.length) {
			const c = content[j] as string;
			if (c === '\n') break;
			if (char === '"' && c === '\\') {
				j += 2;
				continue;
			}
			if (c === char) {
				close = j;
				break;
			}
			j++;
		}
		if (close === -1) {
			out += char;
			i++;
			continue;
		}

		const inner = content.slice(i + 1, close);
		const rewritten = rewriteRequirementText(inner, name, newRange);
		if (rewritten !== null && !rewritten.includes(char)) {
			out += `${char}${rewritten}${char}`;
			touched = true;
		} else {
			out += content.slice(i, close + 1);
		}
		i = close + 1;
	}

	return { content: out, touched };
}

/** `[tool.poetry.dependencies]`-shaped section names, group form included. */
const POETRY_DEPS_SECTION =
	/^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/;

/** `[section]` / `[[section]]` header; quotes stripped before matching. */
const SECTION_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

/** `key = rest` with a bare or quoted key, capturing the layout around `=`. */
const KEY_VALUE =
	/^(\s*)("(?<dq>[^"]+)"|'(?<sq>[^']+)'|[A-Za-z0-9._-]+)(\s*=\s*)(.*)$/;

/** The first quoted string of a value; version constraints never escape. */
const LEADING_STRING = /^"([^"]*)"|^'([^']*)'/;

/** An inline table's `version = "…"` pair. */
const INLINE_VERSION = /(\bversion\s*=\s*)(?:"([^"]*)"|'([^']*)')/;

/**
 * poetry strategy: line-based with `[section]` tracking, so only assignments
 * inside a poetry dependencies section are candidates — a `requests` key under
 * `[tool.something-else]` is a different animal and stays untouched. Plain
 * string values are replaced whole (quote character preserved); inline tables
 * get only their `version` value replaced, so `extras`, `optional`, and
 * git/path tables survive as written (a table without `version` is skipped).
 */
function rewritePoetryValues(
	content: string,
	name: string,
	newRange: string
): { content: string; touched: boolean } {
	const lines = content.split('\n');
	let touched = false;
	let inDepsSection = false;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;

		const header = SECTION_HEADER.exec(line);
		if (header !== null) {
			const section = (header[1] as string).replace(/["']/g, '').trim();
			inDepsSection = POETRY_DEPS_SECTION.test(section);
			continue;
		}
		if (!inDepsSection) continue;

		const keyValue = KEY_VALUE.exec(line);
		if (keyValue === null) continue;
		const keyName =
			keyValue.groups?.dq ??
			keyValue.groups?.sq ??
			(keyValue[2] as string);
		if (normalizePypiName(keyName) !== name) continue;

		const prefixLength =
			(keyValue[1] as string).length +
			(keyValue[2] as string).length +
			(keyValue[5] as string).length;
		const rest = line.slice(prefixLength);

		if (rest.startsWith('"') || rest.startsWith("'")) {
			const value = LEADING_STRING.exec(rest);
			if (value === null) continue;
			const quote = rest[0] as string;
			if (newRange.includes(quote)) continue;
			lines[index] =
				line.slice(0, prefixLength) +
				`${quote}${newRange}${quote}` +
				rest.slice(value[0].length);
			touched = true;
			continue;
		}

		if (rest.startsWith('{')) {
			const version = INLINE_VERSION.exec(rest);
			if (version === null) continue;
			const quote =
				(version[2] as string | undefined) !== undefined ? '"' : "'";
			if (newRange.includes(quote)) continue;
			lines[index] =
				line.slice(0, prefixLength) +
				rest.replace(INLINE_VERSION, `$1${quote}${newRange}${quote}`);
			touched = true;
		}
	}

	return { content: lines.join('\n'), touched };
}

/**
 * `#` starts a comment at position 0 or after whitespace; a `#` glued to
 * content (`…#egg=foo`) is part of the requirement. Mirrors the engine's
 * requirements parser so both sides agree on where a line's comment begins.
 */
function commentStart(line: string): number {
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== '#') continue;
		if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') return i;
	}
	return -1;
}

/**
 * requirements strategy: rewrite each line whose requirement parses to the
 * target, leaving comments, flag lines (`-r …`, `--index-url …`), blank lines
 * and `\`-continued lines (which never parse standalone) exactly as written.
 */
function rewriteRequirementLines(
	content: string,
	name: string,
	newRange: string
): { content: string; touched: boolean } {
	const lines = content.split('\n');
	let touched = false;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;
		const hash = commentStart(line);
		const requirementPart = hash === -1 ? line : line.slice(0, hash);
		const commentPart = hash === -1 ? '' : line.slice(hash);

		const trimmed = requirementPart.trim();
		if (trimmed === '' || trimmed.startsWith('-')) continue;

		const rewritten = rewriteRequirementText(
			requirementPart,
			name,
			newRange
		);
		if (rewritten === null) continue;
		lines[index] = rewritten + commentPart;
		touched = true;
	}

	return { content: lines.join('\n'), touched };
}

/* -------------------------------------------------------------------------- */
/* Poetry bump planning                                                       */
/* -------------------------------------------------------------------------- */

const POETRY_CARET = /^\^\s*\d+(?:\.\d+){0,2}$/;
const POETRY_TILDE = /^~\s*\d+(?:\.\d+){0,2}$/;
const POETRY_EXACT = /^(==\s*)?(\S+)$/;

/**
 * Rewrite a poetry constraint so it points at `targetVersion`, preserving the
 * author's idiom — the same philosophy as the engine's npm `planBump`:
 *
 * - `^2.0` → `^<target>`, `~7.4` → `~<target>`
 * - `1.2.3` (bare exact pin) → `<target>`, `==1.2.3` → `==<target>`
 * - `*` / empty (wildcards are lockfile-only upstream), multi-constraint
 *   sets (`>=2,<3`), `||` unions and git/path/url shapes → untouched,
 *   `reason: 'not-semver'`
 *
 * An invalid target (not PEP 440) or a rewrite that lands on the range that
 * is already written comes back `changed: false` with the reason saying why.
 */
export function poetryStyleBump(
	rawRange: string,
	targetVersion: string
): {
	newRange: string;
	changed: boolean;
	reason?: 'not-semver' | 'already-target' | 'invalid-target';
} {
	const target = targetVersion.trim();
	if (!pep440Versioning.isValidVersion(target)) {
		return { newRange: rawRange, changed: false, reason: 'invalid-target' };
	}

	const value = rawRange.trim();
	if (
		value === '' ||
		value === '*' ||
		value.includes('||') ||
		value.includes(',')
	) {
		return { newRange: rawRange, changed: false, reason: 'not-semver' };
	}

	let newRange: string | null = null;
	if (POETRY_CARET.test(value)) {
		newRange = `^${target}`;
	} else if (POETRY_TILDE.test(value)) {
		newRange = `~${target}`;
	} else {
		const exact = POETRY_EXACT.exec(value);
		if (
			exact !== null &&
			pep440Versioning.isValidVersion(exact[2] as string)
		) {
			newRange = exact[1] === undefined ? target : `==${target}`;
		}
	}

	if (newRange === null) {
		// `>=2.0`, `~=2.0`, git/path/url, inline-table descriptions, …
		return { newRange: rawRange, changed: false, reason: 'not-semver' };
	}
	if (newRange === value) {
		return { newRange: rawRange, changed: false, reason: 'already-target' };
	}
	return { newRange, changed: true };
}
