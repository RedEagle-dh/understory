import semver from 'semver';
import { classifyRange } from './ranges';

export interface BumpPlanInput {
	/** The range currently written in package.json. */
	declaredRange: string;
	/** The version to move to. */
	targetVersion: string;
}

export interface BumpPlanResult {
	newRange: string;
	/** `false` means package.json stays untouched (lockfile-only bump). */
	changed: boolean;
	/** Why the range was left alone, when it was. */
	reason?: 'not-semver' | 'already-target' | 'invalid-target';
}

const CARET = /^\^\s*(v?)(\d[^\s|]*)$/;
const TILDE = /^~\s*(v?)(\d[^\s|]*)$/;
const EXACT = /^(=?)\s*(v?)(\d[^\s|]*)$/;

/**
 * Rewrite a declared range so it points at `targetVersion`, preserving the
 * author's intent:
 *
 * - `^4.17.15` → `^4.17.21`
 * - `~1.2.0` → `~1.2.6`
 * - `1.2.0` (exact) → `1.2.6`
 * - `>=1.0.0`, `1.x`, `>=1 <3`, … → `^target`
 * - `*`, `latest`, `workspace:*`, `catalog:`, `file:`, git/url ranges → untouched
 */
export function planBump(input: BumpPlanInput): BumpPlanResult {
	const declared = input.declaredRange ?? '';
	const target = (input.targetVersion ?? '').trim().replace(/^v/, '');

	if (semver.valid(target, { loose: true }) === null) {
		return { newRange: declared, changed: false, reason: 'invalid-target' };
	}

	const range = declared.trim();
	const kind = classifyRange(range);
	if (kind !== 'semver') {
		return { newRange: declared, changed: false, reason: 'not-semver' };
	}

	let newRange: string;
	const caret = CARET.exec(range);
	const tilde = TILDE.exec(range);
	const exact = EXACT.exec(range);

	if (caret !== null) {
		newRange = `^${caret[1] ?? ''}${target}`;
	} else if (tilde !== null) {
		newRange = `~${tilde[1] ?? ''}${target}`;
	} else if (
		exact !== null &&
		semver.valid(exact[3] as string, { loose: true }) !== null
	) {
		newRange = `${exact[1] ?? ''}${exact[2] ?? ''}${target}`;
	} else {
		// `>=1.0.0`, `1.2.x`, hyphen and compound ranges: caret is the closest
		// equivalent to "this version or the next compatible one".
		newRange = `^${target}`;
	}

	if (newRange === declared) {
		return { newRange: declared, changed: false, reason: 'already-target' };
	}
	return { newRange, changed: true };
}
