import { parse as pep440Parse } from '@renovatebot/pep440';
import { type BumpPlanInput, type BumpPlanResult, planBump } from './bump-plan';
import { detectManager, findRootManifest, parseLockfile } from './lockfiles';
import { OSV_ECOSYSTEM_NAMES } from './osv/normalize';
import { pep440Versioning } from './pep440';
import { detectPypiManager, isPypiPresent, parsePypi } from './pypi';
import type {
	DependencyGraph,
	Ecosystem,
	FileEntry,
	PackageManager,
} from './types';
import { semverVersioning, type Versioning } from './versioning';

/**
 * Everything the scan pipeline needs from one package ecosystem, bundled.
 *
 * The port is pure: detection and parsing work on the fetched file set, and
 * the versioning object carries the ecosystem's comparison semantics. I/O
 * (registry clients, advisory sources) stays in the composition root, keyed by
 * {@link Ecosystem}.
 */
export interface EcosystemPort {
	readonly ecosystem: Ecosystem;
	/** The `package.ecosystem` value OSV expects for this ecosystem. */
	readonly osvEcosystem: string;
	readonly versioning: Versioning;
	/**
	 * `true` when the file set contains this ecosystem's manifests or
	 * lockfiles — the dispatch predicate for polyglot repositories.
	 */
	isPresent(files: readonly FileEntry[]): boolean;
	/** The package manager the lockfiles identify, or `null` without one. */
	detect(files: readonly FileEntry[]): PackageManager | null;
	/** Parse manifests + lockfiles into a {@link DependencyGraph}. */
	parse(files: readonly FileEntry[]): DependencyGraph;
	/** Rewrite a declared range to point at a new target version. */
	planBump(input: BumpPlanInput): BumpPlanResult;
}

export const npmEcosystem: EcosystemPort = {
	ecosystem: 'npm',
	osvEcosystem: 'npm',
	versioning: semverVersioning,
	isPresent(files) {
		return (
			findRootManifest(files) !== undefined ||
			detectManager(files) !== null
		);
	},
	detect: detectManager,
	parse: parseLockfile,
	planBump,
};

const EXACT_PIN = /^==\s*[^\s,*]+$/;
const COMPATIBLE_RELEASE = /^~=\s*[^\s,]+$/;
const WILDCARD_PIN = /^==\s*(.+)\.\*$/;

/**
 * Exclusive upper bound one major above `version`, epoch preserved:
 * `2.32.3` → `3`, `1!2.0` → `1!3`. `null` when the version cannot be parsed.
 */
function nextMajorBound(version: string): string | null {
	const parsed = pep440Parse(version);
	if (parsed === null) return null;
	const major = (parsed.release[0] ?? 0) + 1;
	return parsed.epoch > 0 ? `${parsed.epoch}!${major}` : `${major}`;
}

/**
 * Rewrite a PEP 440 specifier set to point at `targetVersion`, preserving the
 * author's idiom where one exists:
 *
 * - `==1.2.3`     → `==<target>`
 * - `==1.2.*`     → `==<target prefix at the same precision>.*`
 * - `~=1.4.2`     → `~=<target>`
 * - other evaluable sets (`>=1,<2`, …) → `>=<target>,<<next major>` — the
 *   closest PEP 440 equivalent of "this version or the next compatible one"
 * - wildcard / git / url / path ranges → untouched
 */
function planPypiBump(input: BumpPlanInput): BumpPlanResult {
	const declared = input.declaredRange ?? '';
	const target = (input.targetVersion ?? '').trim();
	if (!pep440Versioning.isValidVersion(target)) {
		return { newRange: declared, changed: false, reason: 'invalid-target' };
	}
	const range = declared.trim();

	let newRange: string | null = null;
	const wildcardPin = WILDCARD_PIN.exec(range);
	if (EXACT_PIN.test(range)) {
		newRange = `==${target}`;
	} else if (wildcardPin !== null) {
		const precision = (wildcardPin[1] as string).split('.').length;
		const parsed = pep440Parse(target);
		if (parsed !== null) {
			const prefix = parsed.release
				.slice(0, Math.max(1, precision))
				.join('.');
			newRange = `==${parsed.epoch > 0 ? `${parsed.epoch}!` : ''}${prefix}.*`;
		}
	} else if (COMPATIBLE_RELEASE.test(range)) {
		newRange = `~=${target}`;
	} else if (
		range !== '' &&
		pep440Versioning.classifyRange(range) === 'semver'
	) {
		const bound = nextMajorBound(target);
		if (bound !== null) newRange = `>=${target},<${bound}`;
	}

	if (newRange === null) {
		return { newRange: declared, changed: false, reason: 'not-semver' };
	}
	if (newRange === range) {
		return { newRange: declared, changed: false, reason: 'already-target' };
	}
	return { newRange, changed: true };
}

export const pypiEcosystem: EcosystemPort = {
	ecosystem: 'pypi',
	osvEcosystem: OSV_ECOSYSTEM_NAMES.pypi,
	versioning: pep440Versioning,
	isPresent: isPypiPresent,
	detect: detectPypiManager,
	parse: parsePypi,
	planBump: planPypiBump,
};

/** Registry order doubles as detection priority in polyglot repositories. */
export const ECOSYSTEMS: readonly EcosystemPort[] = [
	npmEcosystem,
	pypiEcosystem,
];

const BY_ID = new Map(ECOSYSTEMS.map((port) => [port.ecosystem, port]));

export function ecosystemFor(id: Ecosystem): EcosystemPort {
	const port = BY_ID.get(id);
	if (port === undefined) throw new Error(`unknown ecosystem "${id}"`);
	return port;
}

/** Every registered ecosystem present in the file set, registry order. */
export function detectEcosystems(files: readonly FileEntry[]): EcosystemPort[] {
	return ECOSYSTEMS.filter((port) => port.isPresent(files));
}
