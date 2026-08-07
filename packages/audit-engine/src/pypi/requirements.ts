import { pep440Versioning } from '../pep440';
import type { ParsedDependency } from '../types';
import { parsePep508 } from './pep508';
import type { DeclaredPypiDep } from './pyproject';

export interface RequirementsParseResult {
	declared: DeclaredPypiDep[];
	/** One entry per exact `==` pin — the only lines with a usable version. */
	pinned: ParsedDependency[];
	warnings: string[];
}

/** An exact pin: a single `==` clause whose operand has no `.*` wildcard. */
const EXACT_PIN = /^==\s*([^\s,*]+)\s*$/;

/**
 * Index where a `#` comment starts: at the beginning of the line or after
 * whitespace. A `#` glued to non-whitespace (`https://…#egg=foo`) is content.
 */
function commentStart(line: string): number {
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== '#') continue;
		if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') return i;
	}
	return -1;
}

/** Join `\`-continued lines into logical lines, per pip's file format. */
function logicalLines(content: string): string[] {
	const lines: string[] = [];
	let buffer = '';
	for (const raw of content.split(/\r?\n/)) {
		const joined = buffer + raw;
		if (joined.endsWith('\\')) {
			buffer = joined.slice(0, -1);
			continue;
		}
		buffer = '';
		lines.push(joined);
	}
	if (buffer !== '') lines.push(buffer);
	return lines;
}

/**
 * Parse a `requirements.txt`.
 *
 * Requirements files are not lockfiles: only exact pins (`pkg==1.2.3`) carry
 * a resolvable version, so those additionally become {@link ParsedDependency}
 * rows (direct, depth 0, prod, root workspace). Everything else only yields a
 * declaration, plus one collective warning that unpinned requirements have no
 * locked version.
 *
 * Pip option lines (`-r other.txt`, `-e .`, `--index-url …`, …) are not
 * followed — the parser is pure and cannot read referenced files — and are
 * skipped with one warning per flag kind. Comments, blank lines and `\` line
 * continuations are handled per pip's file format.
 */
export function parseRequirementsTxt(content: string): RequirementsParseResult {
	const declared: DeclaredPypiDep[] = [];
	const pinned: ParsedDependency[] = [];
	const warnings: string[] = [];
	const warnedFlags = new Set<string>();
	let unpinnedCount = 0;

	for (const logical of logicalLines(content)) {
		let line = logical;
		const hash = commentStart(line);
		if (hash !== -1) line = line.slice(0, hash);
		line = line.trim();
		if (line === '') continue;

		if (line.startsWith('-')) {
			const flag = line.split(/[=\s]/, 1)[0] ?? line;
			if (!warnedFlags.has(flag)) {
				warnedFlags.add(flag);
				warnings.push(
					`requirements.txt: "${flag}" lines are not supported; skipped`
				);
			}
			continue;
		}

		const requirement = parsePep508(line);
		if (requirement === null) {
			warnings.push(`requirements.txt: could not parse "${line}"`);
			continue;
		}

		declared.push({
			name: requirement.name,
			rawRange: line,
			specifier:
				requirement.url === undefined ? requirement.specifier : '',
			depType: 'prod',
			rangeKind:
				requirement.url === undefined
					? pep440Versioning.classifyRange(requirement.specifier)
					: requirement.url.startsWith('git+')
						? 'git'
						: 'url',
		});

		const pin = EXACT_PIN.exec(requirement.specifier);
		if (pin !== null) {
			pinned.push({
				name: requirement.name,
				version: pin[1] as string,
				workspace: '',
				depType: 'prod',
				isDirect: true,
				depth: 0,
				declaredRange: requirement.specifier,
				rawRange: line,
			});
		} else {
			unpinnedCount++;
		}
	}

	if (unpinnedCount > 0) {
		warnings.push(
			`requirements.txt: ${unpinnedCount} requirement(s) are not pinned with "=="; they have no locked version`
		);
	}

	return { declared, pinned, warnings };
}
