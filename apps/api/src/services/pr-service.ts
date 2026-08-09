import type { LoggerPort } from '@declarativejs/core';
import {
	type Ecosystem,
	type EcosystemPort,
	ecosystemFor,
	type PackageManager,
	parseJsonManifest,
	pep440Versioning,
	type Severity,
	semverVersioning,
	type UpdateKind,
	type Versioning,
} from '@workspace/audit-engine';
import type { GithubClient } from '../adapters/github/client';
import { createPrWriter, type RepoTarget } from '../adapters/github/pr-writer';
import type { RepoFile, RepoReader } from '../adapters/github/repo-reader';
import type { PullRequestBumpSummary } from '../adapters/notifications/templates/pr-opened';
import {
	GithubError,
	InvalidInputError,
	NotFoundError,
	PrAlreadyOpenError,
} from '../errors';
import type {
	DependencySetEntryRow,
	DependencySetsStore,
} from '../stores/dependency-sets';
import type { DependencyStatusStore } from '../stores/dependency-status';
import type { FindingRow, FindingsStore } from '../stores/findings';
import type { ProjectRow, ProjectsStore } from '../stores/projects';
import type {
	PullRequestBumpInput,
	PullRequestBumpRow,
	PullRequestRow,
	PullRequestsStore,
} from '../stores/pull-requests';
import type { ScansStore } from '../stores/scans';
import { regenerateLockfile } from './lockfile-regen';
import type { PrMergedEvent, PrOpenedEvent } from './notification-service';
import type { AutoPrInput, AutoPrPort } from './ports';
import {
	applyPypiRangeEdits,
	buildPypiManifestIndex,
	poetryStyleBump,
} from './pypi-manifests';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/** Composite-key separator that cannot occur in a package name or path. */
const NUL = String.fromCharCode(0);

/** A `creating` row older than this never reached GitHub — bury it. */
const CREATING_TIMEOUT_MS = 15 * 60_000;

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low'] as const;
const SEVERITY_RANK: Record<Severity, number> = {
	low: 0,
	moderate: 1,
	high: 2,
	critical: 3,
};

/** Lockfiles we can regenerate, keyed by the manager that owns them. */
const LOCKFILE_NAMES: Partial<Record<PackageManager, string>> = {
	npm: 'package-lock.json',
	bun: 'bun.lock',
	pnpm: 'pnpm-lock.yaml',
	yarn: 'yarn.lock',
	uv: 'uv.lock',
	poetry: 'poetry.lock',
};

/** The manifest file a PR of this ecosystem edits (pip edits requirements.txt directly). */
const MANIFEST_BASENAME: Record<Ecosystem, string> = {
	npm: 'package.json',
	pypi: 'pyproject.toml',
};

/** The command a human runs to refresh the lockfile when regen was skipped. */
const LOCKFILE_COMMANDS: Partial<Record<PackageManager, string>> = {
	npm: 'npm install',
	bun: 'bun install',
	pnpm: 'pnpm install --lockfile-only',
	yarn: 'yarn install',
	uv: 'uv lock',
	poetry: 'poetry lock',
};

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface PrSelectionInput {
	name: string;
	/** '' = the workspace root; omitted = wherever the package is declared. */
	workspace?: string;
	/** Explicit target; otherwise max `fixedIn` of open findings, else `latest`. */
	toVersion?: string;
}

/**
 * `changesManifest` — the declared range is rewritten.
 * `lockfileOnly`   — the range already admits the target; only the lockfile moves.
 * `dropped`        — nothing can be done; `reason` says why.
 */
export type PrPlanItemStatus = 'changesManifest' | 'lockfileOnly' | 'dropped';

export interface PrPlanAdvisory {
	advisoryId: string;
	findingId: string;
	severity: Severity;
	url: string;
}

export interface PrPlanItem {
	packageName: string;
	workspace: string;
	/** '' → 'package.json'; 'apps/web' → 'apps/web/package.json'. */
	manifestPath: string;
	status: PrPlanItemStatus;
	fromVersion: string | null;
	fromRange: string | null;
	toVersion: string | null;
	newRange: string | null;
	updateKind: UpdateKind;
	severity: Severity | null;
	advisories: PrPlanAdvisory[];
	reason: string | null;
	warnings: string[];
}

export interface PrPlanSeverityCounts {
	critical: number;
	high: number;
	moderate: number;
	low: number;
}

export interface PrPlanExistingPr {
	id: string;
	number: number | null;
	url: string | null;
	branch: string;
	state: PullRequestRow['state'];
}

export interface PrPlan {
	projectId: string;
	projectName: string;
	/** Drives the branch prefix: `security` iff any included item cites an advisory. */
	branchKind: 'security' | 'update';
	branch: string;
	baseBranch: string;
	title: string;
	body: string;
	items: PrPlanItem[];
	includedCount: number;
	droppedCount: number;
	severityCounts: PrPlanSeverityCounts;
	/** Manifest paths the commit would touch (empty for a lockfile-only PR). */
	manifestPaths: string[];
	lockfileRegenPlanned: boolean;
	lockfileNote: string | null;
	warnings: string[];
	/** Set when an in-flight PR already covers every included bump. */
	alreadyOpenPr: PrPlanExistingPr | null;
}

export interface CreatePrOptions {
	kind: PullRequestRow['kind'];
	actorUserId?: string;
}

export interface CreatePrResult {
	id: string;
	number: number;
	url: string;
	branch: string;
	lockfileUpdated: boolean;
}

export interface GithubAccessPort {
	forToken(token?: string): { client: GithubClient; reader: RepoReader };
	resolveToken(project: ProjectRow | null): Promise<string | undefined>;
}

export interface PrServiceConfig {
	enableLockfileRegen: boolean;
	appUrl: string;
}

export interface PrServiceDeps {
	projects: ProjectsStore;
	scans: ScansStore;
	dependencySets: DependencySetsStore;
	dependencyStatus: DependencyStatusStore;
	findings: FindingsStore;
	pullRequests: PullRequestsStore;
	github: GithubAccessPort;
	dispatchEvent: (event: PrOpenedEvent | PrMergedEvent) => Promise<void>;
	config: PrServiceConfig;
	log?: LoggerPort;
	/** Test seam. */
	regenerate?: typeof regenerateLockfile;
	now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for tests)                                          */
/* -------------------------------------------------------------------------- */

export function manifestPathFor(
	workspace: string,
	basename = 'package.json'
): string {
	return workspace === '' ? basename : `${workspace}/${basename}`;
}

/* -------------------------------------------------------------------------- */
/* Manifest index — what the repository LITERALLY says                        */
/* -------------------------------------------------------------------------- */

/**
 * `dependency_set_entries.declaredRange` holds the RESOLVED range: the scan
 * already substituted `catalog:` / `catalog:<group>` for the value the root
 * manifest carries. Rewriting a range therefore cannot be planned from the
 * database alone — the workspace manifest literally says `catalog:frontend`,
 * and writing a semver range over that would silently unhook the package from
 * its catalog. Everything below reads the FETCHED manifests instead, so plan
 * and create agree on what is written where.
 */

const DEP_SECTIONS = [
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
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

/** How a declaration is written in its file — decides the edit strategy. */
export type DeclarationStyle = 'pep621' | 'poetry' | 'requirements';

/** Where the range that governs a dependency is actually written. */
export interface ManifestDeclaration {
	/** What the workspace manifest literally says: `^1.2.3`, `catalog:frontend`. */
	rawRange: string;
	/** The range that governs resolution — `catalog:` resolved against the root. */
	effectiveRange: string;
	/** The manifest a rewrite of `effectiveRange` has to edit. */
	editPath: string;
	/** Set when the edit lands in the root `catalog` ('') / `catalogs.<group>`. */
	catalogGroup?: string;
	/** A `catalog:` range with no matching entry in the root manifest. */
	missingCatalogEntry: boolean;
	/** Python declaration syntax; undefined for npm's package.json. */
	style?: DeclarationStyle;
}

export interface ManifestIndex {
	/** Repo-relative path of the shallowest package.json. */
	rootPath: string;
	/** Repo-relative path of a workspace's manifest, root-relative naming. */
	pathForWorkspace(workspace: string): string;
	/** Repo-relative path of a root-level file such as `bun.lock`. */
	pathAtRoot(name: string): string;
	declaration(
		workspace: string,
		name: string
	): ManifestDeclaration | undefined;
	/** Every package.json path in the snapshot, root first. */
	manifestPaths(): string[];
}

/**
 * Index every package.json in a repository snapshot by workspace path, using
 * the same root/relative convention the scan's manifest parser uses (shallowest
 * manifest is the root; a workspace's key is its directory relative to it).
 */
export function buildManifestIndex(
	files: readonly RepoFile[]
): ManifestIndex | null {
	const manifests = files.filter(
		(file) =>
			basenameOf(file.path) === 'package.json' &&
			!file.path.includes('node_modules/')
	);
	let shallowest = manifests[0];
	if (shallowest === undefined) return null;
	for (const file of manifests) {
		if (
			depthOf(file.path) < depthOf(shallowest.path) ||
			(depthOf(file.path) === depthOf(shallowest.path) &&
				file.path < shallowest.path)
		) {
			shallowest = file;
		}
	}
	const rootFile = shallowest;

	const rootDir = dirnameOf(rootFile.path);
	const rootJson = asRecord(parseJsonManifest(rootFile.content).json);
	const catalog = asRecord(rootJson?.catalog);
	const catalogs = asRecord(rootJson?.catalogs);

	const byWorkspace = new Map<
		string,
		{ path: string; json: Record<string, unknown> | null }
	>();
	const paths: string[] = [];
	for (const file of manifests) {
		const directory = dirnameOf(file.path);
		const workspace =
			file.path === rootFile.path
				? ''
				: rootDir === ''
					? directory
					: directory === rootDir
						? ''
						: directory.slice(rootDir.length + 1);
		paths.push(file.path);
		if (byWorkspace.has(workspace)) continue;
		byWorkspace.set(workspace, {
			path: file.path,
			json: asRecord(parseJsonManifest(file.content).json),
		});
	}

	function catalogBucket(group: string): Record<string, unknown> | null {
		return group === '' ? catalog : asRecord(catalogs?.[group]);
	}

	return {
		rootPath: rootFile.path,
		pathForWorkspace(workspace) {
			const known = byWorkspace.get(workspace);
			if (known !== undefined) return known.path;
			const relative = manifestPathFor(workspace);
			return rootDir === '' ? relative : `${rootDir}/${relative}`;
		},
		pathAtRoot(name) {
			return rootDir === '' ? name : `${rootDir}/${name}`;
		},
		manifestPaths: () => [...paths],
		declaration(workspace, name) {
			const entry = byWorkspace.get(workspace);
			if (entry === undefined || entry.json === null) return undefined;

			let rawRange: string | undefined;
			for (const section of DEP_SECTIONS) {
				const value = asRecord(entry.json[section])?.[name];
				if (typeof value === 'string') {
					rawRange = value;
					break;
				}
			}
			if (rawRange === undefined) return undefined;

			if (!rawRange.startsWith('catalog:')) {
				return {
					rawRange,
					effectiveRange: rawRange,
					editPath: entry.path,
					missingCatalogEntry: false,
				};
			}

			const declared = rawRange.slice('catalog:'.length).trim();
			const group = declared === 'default' ? '' : declared;
			const value = catalogBucket(group)?.[name];
			return typeof value === 'string'
				? {
						rawRange,
						effectiveRange: value,
						editPath: rootFile.path,
						catalogGroup: group,
						missingCatalogEntry: false,
					}
				: {
						rawRange,
						// Unresolvable: keep the literal so classification drops it.
						effectiveRange: rawRange,
						editPath: rootFile.path,
						catalogGroup: group,
						missingCatalogEntry: true,
					};
		},
	};
}

/**
 * `understory/{security|update}-{sha256(sorted "name@to").slice(0,8)}`.
 *
 * Deterministic on purpose: a crash between "row inserted" and "PR opened"
 * leaves a branch that the retry finds and reuses, so the repo never collects
 * `understory/update-1`, `-2`, `-3` for the same bump. Selection ORDER must not
 * matter, hence the sort.
 */
export function branchNameFor(
	kind: 'security' | 'update',
	bumps: readonly { packageName: string; toVersion: string }[]
): string {
	const identity = [
		...new Set(
			bumps.map((bump) => `${bump.packageName}@${bump.toVersion}`)
		),
	].sort();
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(identity.join('\n'));
	return `understory/${kind}-${hasher.digest('hex').slice(0, 8)}`;
}

function severityPhrase(counts: PrPlanSeverityCounts): string {
	return SEVERITY_ORDER.filter((severity) => counts[severity] > 0)
		.map((severity) => `${counts[severity]} ${severity}`)
		.join(', ');
}

export function titleFor(
	kind: 'security' | 'update',
	items: readonly PrPlanItem[],
	counts: PrPlanSeverityCounts
): string {
	const names = [...new Set(items.map((item) => item.packageName))];
	if (kind === 'security') {
		const listed = names.slice(0, 3).join(', ');
		const overflow =
			names.length > 3 ? ` and ${names.length - 3} more` : '';
		const phrase = severityPhrase(counts);
		const suffix = phrase === '' ? '' : ` (${phrase})`;
		return `chore(deps): security update for ${listed}${overflow}${suffix}`;
	}
	if (names.length === 1) {
		const only = items[0];
		return `chore(deps): bump ${names[0]} to ${only?.toVersion ?? ''}`;
	}
	return `chore(deps): bump ${names.length} dependencies`;
}

function advisoryLink(advisoryId: string): string {
	return advisoryId.startsWith('GHSA-')
		? `https://github.com/advisories/${advisoryId}`
		: `https://osv.dev/vulnerability/${advisoryId}`;
}

function tableCell(value: string | null): string {
	return value === null || value === '' ? '—' : `\`${value}\``;
}

export function bodyFor(input: {
	projectName: string;
	appUrl: string;
	items: readonly PrPlanItem[];
	counts: PrPlanSeverityCounts;
	lockfileUpdated: boolean;
	lockfileNote: string | null;
	manager: PackageManager;
}): string {
	const lines: string[] = [];
	lines.push('| Package | From | To | Why |', '| --- | --- | --- | --- |');
	for (const item of input.items) {
		const scope =
			item.workspace === '' ? '' : ` <sub>${item.workspace}</sub>`;
		const why =
			item.advisories.length === 0
				? item.updateKind === 'none'
					? 'dependency update'
					: `${item.updateKind} update`
				: item.advisories
						.map(
							(advisory) =>
								`[${advisory.advisoryId}](${advisoryLink(advisory.advisoryId)}) (${advisory.severity})`
						)
						.join('<br>');
		lines.push(
			`| \`${item.packageName}\`${scope} | ${tableCell(item.fromRange ?? item.fromVersion)} | ${tableCell(item.newRange ?? item.toVersion)} | ${why} |`
		);
	}

	const phrase = severityPhrase(input.counts);
	if (phrase !== '') {
		lines.push('', `**Advisories resolved:** ${phrase}.`);
	}

	const majors = input.items.filter((item) => item.updateKind === 'major');
	if (majors.length > 0) {
		lines.push(
			'',
			`⚠️ **Major version ${majors.length === 1 ? 'bump' : 'bumps'}:** ${majors
				.map((item) => `\`${item.packageName}\``)
				.join(', ')} — review the changelog before merging.`
		);
	}

	// pip has no separate lockfile: the requirements.txt pins ARE the
	// resolution, and this PR just edited them.
	if (input.manager !== 'pip') {
		const installCommand = LOCKFILE_COMMANDS[input.manager] ?? 'an install';
		lines.push(
			'',
			input.lockfileUpdated
				? 'The lockfile was regenerated in the same commit.'
				: `The lockfile was not regenerated${
						input.lockfileNote === null
							? ''
							: ` (${input.lockfileNote})`
					}; run \`${installCommand}\` before merging.`
		);
	}

	lines.push(
		'',
		'---',
		`Opened automatically by [understory](${input.appUrl}) for project **${input.projectName}**.`
	);
	return lines.join('\n');
}

export interface ManifestRangeEdit {
	packageName: string;
	newRange: string;
	/**
	 * Present → rewrite the root `catalog` (`''`) / `catalogs.<group>` entry
	 * rather than a dependency section. That is the ONLY correct edit for a
	 * workspace whose manifest says `"react": "catalog:frontend"`.
	 */
	catalogGroup?: string;
}

/** A {@link ManifestRangeEdit} bound to the manifest it has to be applied to. */
interface PlannedEdit extends ManifestRangeEdit {
	/** Repository-relative path — a workspace manifest, or the root for catalogs. */
	path: string;
	/** Python declaration syntax the edit must use; undefined for package.json. */
	style?: DeclarationStyle;
}

/** Base-branch manifests, shared by `plan` and the `create` that follows it. */
interface PlanSnapshot {
	branch: string;
	files: RepoFile[];
	index: ManifestIndex | null;
}

interface InternalPlan {
	plan: PrPlan;
	/** `${workspace}\0${name}` → the manifest edit that realises the bump. */
	edits: Map<string, PlannedEdit>;
	snapshot: PlanSnapshot | null;
}

/**
 * String-precise manifest edit.
 *
 * `JSON.parse` preserves the source's key order (integer-like keys aside, which
 * package names never are) and mutating a value in place never moves its key,
 * so `JSON.stringify` of the mutated object round-trips the file with only the
 * intended ranges changed. Indentation and the trailing newline are sniffed
 * from the original rather than assumed, so a 4-space or tab-indented
 * package.json does not come back reformatted top to bottom.
 *
 * Edits carrying a `catalogGroup` land in the root manifest's `catalog` /
 * `catalogs.<group>` object instead of a dependency section, which is where a
 * `catalog:`-sourced range actually lives.
 */
export function applyRangeEdits(
	content: string,
	edits: readonly ManifestRangeEdit[]
): { content: string; applied: string[] } {
	const parsed: unknown = JSON.parse(content);
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		Array.isArray(parsed)
	) {
		throw new InvalidInputError('package.json is not a JSON object');
	}
	const manifest = parsed as Record<string, unknown>;

	const applied: string[] = [];
	for (const edit of edits) {
		if (edit.catalogGroup !== undefined) {
			const bucket =
				edit.catalogGroup === ''
					? asRecord(manifest.catalog)
					: asRecord(
							asRecord(manifest.catalogs)?.[edit.catalogGroup]
						);
			if (bucket !== null && edit.packageName in bucket) {
				bucket[edit.packageName] = edit.newRange;
				applied.push(edit.packageName);
			}
			continue;
		}

		let touched = false;
		for (const section of DEP_SECTIONS) {
			const record = asRecord(manifest[section]);
			if (record === null) continue;
			if (!(edit.packageName in record)) continue;
			record[edit.packageName] = edit.newRange;
			touched = true;
		}
		if (touched) applied.push(edit.packageName);
	}

	return {
		content: stringifyLike(content, manifest),
		applied,
	};
}

function stringifyLike(original: string, value: unknown): string {
	const indentMatch = /\n([ \t]+)"/.exec(original);
	const indent = indentMatch?.[1] ?? '  ';
	const trailing = original.endsWith('\n') ? '\n' : '';
	return `${JSON.stringify(value, null, indent)}${trailing}`;
}

function maxVersion(
	versions: readonly string[],
	versioning: Versioning
): string | null {
	let best: string | null = null;
	for (const version of versions) {
		if (!versioning.isValidVersion(version)) continue;
		if (best === null || versioning.compare(version, best) > 0) {
			best = version;
		}
	}
	return best;
}

/**
 * Ecosystem-blind "is `candidate` newer": the auto-PR grouping runs before
 * any project context is loaded, so it tries both version grammars.
 */
function isNewerVersion(candidate: string, current: string): boolean {
	if (
		semverVersioning.isValidVersion(candidate) &&
		semverVersioning.isValidVersion(current)
	) {
		return semverVersioning.compare(candidate, current) > 0;
	}
	if (
		pep440Versioning.isValidVersion(candidate) &&
		pep440Versioning.isValidVersion(current)
	) {
		return pep440Versioning.compare(candidate, current) > 0;
	}
	return candidate > current;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseJsonArray(value: string | null): string[] | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === 'string')
			: null;
	} catch {
		return null;
	}
}

function toBumpSummaries(
	bumps: readonly PullRequestBumpRow[]
): PullRequestBumpSummary[] {
	return bumps.map((bump) => ({
		packageName: bump.packageName,
		workspace: bump.workspace,
		fromVersion: bump.fromVersion,
		toVersion: bump.toVersion,
		...(bump.advisoryId === null ? {} : { advisoryId: bump.advisoryId }),
	}));
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export function createPrService(deps: PrServiceDeps) {
	const log = deps.log;
	const clock = deps.now ?? (() => new Date());
	const regenerate = deps.regenerate ?? regenerateLockfile;

	/* ------------------------------------------------------------------ */
	/* Planning                                                            */
	/* ------------------------------------------------------------------ */

	interface ResolutionContext {
		project: ProjectRow;
		ecosystem: Ecosystem;
		port: EcosystemPort;
		manager: PackageManager;
		/** `${workspace}\0${name}` → the most authoritative entry. */
		entries: Map<string, DependencySetEntryRow>;
		/** name → workspaces that DECLARE it (i.e. have a range to rewrite). */
		declaredIn: Map<string, string[]>;
		status: Map<
			string,
			{
				currentVersion: string;
				declaredRange: string | null;
				latestVersion: string | null;
			}
		>;
		findings: Map<string, FindingRow[]>;
	}

	async function loadContext(
		project: ProjectRow
	): Promise<ResolutionContext> {
		const scanId = project.lastSuccessScanId;
		if (scanId === null) {
			throw new InvalidInputError(
				`Project ${project.id} has no successful scan yet; run a scan before opening a pull request.`
			);
		}
		const scan = await deps.scans.get(scanId);
		if (scan === null || scan.dependencySetId === null) {
			throw new InvalidInputError(
				`Project ${project.id} has no usable dependency snapshot; run a scan before opening a pull request.`
			);
		}
		const setRow = await deps.dependencySets.byId(scan.dependencySetId);
		if (setRow === null) {
			throw new InvalidInputError(
				`Project ${project.id} has no usable dependency snapshot; run a scan before opening a pull request.`
			);
		}

		const rows = await deps.dependencySets.entriesForSet(setRow.id);
		const entries = new Map<string, DependencySetEntryRow>();
		const declaredIn = new Map<string, string[]>();
		for (const row of rows) {
			const key = `${row.workspace}${NUL}${row.name}`;
			const current = entries.get(key);
			if (
				current === undefined ||
				(row.isDirect && !current.isDirect) ||
				(row.isDirect === current.isDirect && row.depth < current.depth)
			) {
				entries.set(key, row);
			}
			if (row.declaredRange !== null) {
				const bucket = declaredIn.get(row.name);
				if (bucket === undefined)
					declaredIn.set(row.name, [row.workspace]);
				else if (!bucket.includes(row.workspace)) {
					bucket.push(row.workspace);
				}
			}
		}
		for (const bucket of declaredIn.values()) bucket.sort();

		const statusRows = await deps.dependencyStatus.forProject(project.id);
		const status = new Map<
			string,
			{
				currentVersion: string;
				declaredRange: string | null;
				latestVersion: string | null;
			}
		>();
		for (const row of statusRows) {
			status.set(`${row.workspace}${NUL}${row.packageName}`, {
				currentVersion: row.currentVersion,
				declaredRange: row.declaredRange,
				latestVersion: row.latestVersion,
			});
		}

		return {
			project,
			ecosystem: setRow.ecosystem,
			port: ecosystemFor(setRow.ecosystem),
			manager: setRow.manager,
			entries,
			declaredIn,
			status,
			findings: new Map(),
		};
	}

	function resolveWorkspace(
		context: ResolutionContext,
		selection: PrSelectionInput
	): string {
		if (selection.workspace !== undefined) return selection.workspace;
		const declared = context.declaredIn.get(selection.name);
		if (declared === undefined || declared.length === 0) return '';
		return declared.includes('') ? '' : (declared[0] as string);
	}

	function planOne(
		context: ResolutionContext,
		selection: PrSelectionInput,
		lockfileRegenAvailable: boolean,
		index: ManifestIndex | null
	): { item: PrPlanItem; edit: PlannedEdit | null } {
		const versioning = context.port.versioning;
		const workspace = resolveWorkspace(context, selection);
		const key = `${workspace}${NUL}${selection.name}`;
		const entry = context.entries.get(key);
		const status = context.status.get(key);

		// The FETCHED manifest outranks the scan snapshot: it is the content
		// `create` will edit, and it is the only place where a `catalog:`
		// indirection is still visible (the database stores it pre-resolved).
		const declaration = index?.declaration(workspace, selection.name);
		const manifestPath =
			declaration?.editPath ??
			index?.pathForWorkspace(workspace) ??
			manifestPathFor(workspace, MANIFEST_BASENAME[context.ecosystem]);

		const fromVersion = entry?.version ?? status?.currentVersion ?? null;
		const fromRange =
			declaration?.effectiveRange ??
			entry?.declaredRange ??
			status?.declaredRange ??
			null;

		const openFindings = (
			context.findings.get(selection.name) ?? []
		).filter(
			(finding) =>
				finding.workspace === workspace || finding.workspace === ''
		);
		const advisories: PrPlanAdvisory[] = openFindings.map((finding) => ({
			advisoryId: finding.advisoryId,
			findingId: finding.id,
			severity: finding.severity,
			url: advisoryLink(finding.advisoryId),
		}));
		const severity = advisories.reduce<Severity | null>(
			(worst, advisory) =>
				worst === null ||
				SEVERITY_RANK[advisory.severity] > SEVERITY_RANK[worst]
					? advisory.severity
					: worst,
			null
		);

		const toVersion =
			selection.toVersion ??
			maxVersion(
				openFindings
					.map((finding) => finding.fixedIn)
					.filter((fixedIn): fixedIn is string => fixedIn !== null),
				versioning
			) ??
			status?.latestVersion ??
			null;

		const base: PrPlanItem = {
			packageName: selection.name,
			workspace,
			manifestPath,
			status: 'dropped',
			fromVersion,
			fromRange,
			toVersion,
			newRange: null,
			updateKind:
				fromVersion !== null && toVersion !== null
					? versioning.updateKindBetween(fromVersion, toVersion)
					: 'none',
			severity,
			advisories,
			reason: null,
			warnings: [],
		};

		const drop = (
			reason: string,
			warnings: string[] = []
		): { item: PrPlanItem; edit: null } => ({
			item: { ...base, warnings, reason },
			edit: null,
		});

		if (entry === undefined && status === undefined) {
			return drop('not present in the last successful scan');
		}
		if (declaration?.missingCatalogEntry === true) {
			return drop(
				`\`${declaration.rawRange}\` has no entry for ${selection.name} in ${index?.rootPath ?? 'package.json'}`
			);
		}
		if (fromRange === null) {
			return drop(
				'not declared in any package.json (transitive dependency)'
			);
		}
		if (toVersion === null) {
			return drop('no target version is known');
		}
		if (!versioning.isValidVersion(toVersion)) {
			return drop(`target version ${toVersion} is not a valid version`);
		}
		if (
			fromVersion !== null &&
			versioning.isValidVersion(fromVersion) &&
			versioning.compare(toVersion, fromVersion) <= 0
		) {
			return drop(
				`already at ${fromVersion}, which is not older than ${toVersion}`
			);
		}

		const warnings =
			base.updateKind === 'major'
				? [
						`${selection.name} ${fromVersion ?? '?'} → ${toVersion} is a MAJOR bump and may contain breaking changes`,
					]
				: [];

		// A wildcard or dist-tag range admits every version by construction, and
		// an evaluable range may already admit the target: both are lockfile-only.
		const rangeKind = versioning.classifyRange(fromRange);
		const admitsTarget =
			rangeKind === 'wildcard' ||
			rangeKind === 'tag' ||
			versioning.satisfies(toVersion, fromRange);

		if (admitsTarget) {
			if (!lockfileRegenAvailable) {
				return drop(
					`\`${fromRange}\` already allows ${toVersion}, so this bump requires lockfile regeneration, which is disabled`,
					warnings
				);
			}
			return {
				item: {
					...base,
					warnings,
					status: 'lockfileOnly',
					newRange: fromRange,
				},
				edit: null,
			};
		}

		// A poetry declaration is rewritten in poetry's own syntax (`^2.0` →
		// `^2.1.4`); everything else goes through the ecosystem's planBump on
		// the effective range.
		const bump =
			declaration?.style === 'poetry'
				? poetryStyleBump(declaration.rawRange, toVersion)
				: context.port.planBump({
						declaredRange: fromRange,
						targetVersion: toVersion,
					});
		if (!bump.changed) {
			return drop(
				bump.reason === 'not-semver'
					? `\`${fromRange}\` is a ${rangeKind} range and cannot be rewritten automatically`
					: `\`${fromRange}\` cannot be rewritten to ${toVersion} (${bump.reason ?? 'unchanged'})`,
				warnings
			);
		}

		// A catalog rewrite is repo-wide by nature: say so before it is opened.
		const catalogWarnings =
			declaration?.catalogGroup === undefined
				? []
				: [
						`${selection.name} is declared as \`${declaration.rawRange}\`; the range is rewritten in ${manifestPath}, which moves every workspace using that catalog entry`,
					];

		return {
			item: {
				...base,
				warnings: [...warnings, ...catalogWarnings],
				status: 'changesManifest',
				newRange: bump.newRange,
			},
			edit: {
				path: manifestPath,
				packageName: selection.name,
				newRange: bump.newRange,
				...(declaration?.catalogGroup === undefined
					? {}
					: { catalogGroup: declaration.catalogGroup }),
				...(declaration?.style === undefined
					? {}
					: { style: declaration.style }),
			},
		};
	}

	/**
	 * Base-branch manifests, or `null` when GitHub cannot be read.
	 *
	 * A preview must not 502 because the repo is briefly unreachable, so
	 * planning degrades to the scan's (already catalog-resolved) ranges and
	 * says so in `warnings`; `create` re-fetches and surfaces the real error.
	 * Every request goes through the ETag-caching client, so a second plan for
	 * an unchanged repo costs no rate-limit quota.
	 */
	function buildIndexFor(
		ecosystem: Ecosystem,
		manager: PackageManager,
		files: readonly RepoFile[]
	): ManifestIndex | null {
		if (ecosystem === 'npm') return buildManifestIndex(files);
		return buildPypiManifestIndex(
			files,
			manager === 'poetry' ? 'poetry' : manager === 'pip' ? 'pip' : 'uv'
		);
	}

	async function fetchSnapshot(
		project: ProjectRow,
		context: ResolutionContext
	): Promise<PlanSnapshot | null> {
		try {
			const token = await deps.github.resolveToken(project);
			const { reader } = deps.github.forToken(token);
			const target = { owner: project.owner, repo: project.repo };
			const branch = await reader.resolveBranch({
				...target,
				branch: project.prBaseBranch ?? project.branch,
			});
			const snapshot = await reader.snapshot(
				{ ...target, branch },
				parseJsonArray(project.manifestPathsJson)
			);
			return {
				branch,
				files: snapshot.files,
				index: buildIndexFor(
					context.ecosystem,
					context.manager,
					snapshot.files
				),
			};
		} catch (error) {
			log?.warn('pull request plan could not read the base branch', {
				projectId: project.id,
				error: messageOf(error),
			});
			return null;
		}
	}

	async function planInternal(
		projectId: string,
		selections: readonly PrSelectionInput[]
	): Promise<InternalPlan> {
		const project = await deps.projects.get(projectId);
		if (project === null) throw new NotFoundError('Project', projectId);

		const context = await loadContext(project);
		const names = [
			...new Set(selections.map((selection) => selection.name)),
		];
		context.findings = await deps.findings.openForPackageNames(
			project.id,
			names
		);

		const snapshot = await fetchSnapshot(project, context);
		const index = snapshot?.index ?? null;

		const lockfileRegenAvailable =
			deps.config.enableLockfileRegen &&
			project.regenerateLockfile &&
			LOCKFILE_NAMES[context.manager] !== undefined;

		const seen = new Set<string>();
		const items: PrPlanItem[] = [];
		const edits = new Map<string, PlannedEdit>();
		for (const selection of selections) {
			const planned = planOne(
				context,
				selection,
				lockfileRegenAvailable,
				index
			);
			const key = `${planned.item.workspace}${NUL}${planned.item.packageName}`;
			if (seen.has(key)) continue;
			seen.add(key);
			items.push(planned.item);
			if (planned.edit !== null) edits.set(key, planned.edit);
		}

		const included = items.filter((item) => item.status !== 'dropped');
		const counts: PrPlanSeverityCounts = {
			critical: 0,
			high: 0,
			moderate: 0,
			low: 0,
		};
		for (const item of included) {
			if (item.severity !== null) counts[item.severity] += 1;
		}

		const branchKind = included.some((item) => item.advisories.length > 0)
			? 'security'
			: 'update';
		const branch = branchNameFor(
			branchKind,
			included.map((item) => ({
				packageName: item.packageName,
				toVersion: item.toVersion as string,
			}))
		);
		const title = titleFor(branchKind, included, counts);
		const manifestPaths = [
			...new Set(
				included
					.filter((item) => item.status === 'changesManifest')
					.map((item) => item.manifestPath)
			),
		].sort();

		// Workspaces used to be a hard stop here. They no longer are: the repo
		// snapshot carries EVERY package.json, so the sandbox can materialise a
		// complete monorepo and the installer resolves it exactly as it would
		// in a real checkout.
		const lockfileRegenPlanned =
			lockfileRegenAvailable && included.length > 0;
		// pip has no lockfile at all — its "note: none" is not a limitation.
		const lockfileNote =
			lockfileRegenPlanned || context.manager === 'pip'
				? null
				: !deps.config.enableLockfileRegen
					? 'lockfile regeneration is disabled on this server'
					: !project.regenerateLockfile
						? 'lockfile regeneration is disabled for this project'
						: LOCKFILE_NAMES[context.manager] === undefined
							? `lockfile regeneration is not supported for ${context.manager}`
							: null;

		const existing =
			included.length === 0
				? null
				: await deps.pullRequests.findCovering(
						project.id,
						included.map((item) => ({
							packageName: item.packageName,
							workspace: item.workspace,
							toVersion: item.toVersion as string,
						}))
					);

		const plan: PrPlan = {
			projectId: project.id,
			projectName: project.name,
			branchKind,
			branch,
			baseBranch:
				snapshot?.branch ?? project.prBaseBranch ?? project.branch,
			title,
			body: bodyFor({
				projectName: project.name,
				appUrl: deps.config.appUrl,
				items: included,
				counts,
				lockfileUpdated: lockfileRegenPlanned,
				lockfileNote,
				manager: context.manager,
			}),
			items,
			includedCount: included.length,
			droppedCount: items.length - included.length,
			severityCounts: counts,
			manifestPaths,
			lockfileRegenPlanned,
			lockfileNote,
			warnings: [
				...(snapshot === null
					? [
							'the base branch could not be read; ranges below come from the last scan, not from the current manifests',
						]
					: []),
				...included.flatMap((item) => item.warnings),
			],
			alreadyOpenPr:
				existing === null
					? null
					: {
							id: existing.id,
							number: existing.number,
							url: existing.url,
							branch: existing.branch,
							state: existing.state,
						},
		};

		return { plan, edits, snapshot };
	}

	async function plan(
		projectId: string,
		selections: readonly PrSelectionInput[]
	): Promise<PrPlan> {
		return (await planInternal(projectId, selections)).plan;
	}

	/* ------------------------------------------------------------------ */
	/* Creation                                                            */
	/* ------------------------------------------------------------------ */

	function alreadyOpen(row: PullRequestRow): PrAlreadyOpenError {
		return new PrAlreadyOpenError({
			id: row.id,
			number: row.number,
			url: row.url,
			branch: row.branch,
		});
	}

	interface CommitPlan {
		files: RepoFile[];
		lockfileUpdated: boolean;
		lockfileNote: string | null;
	}

	async function buildCommitFiles(
		project: ProjectRow,
		prPlan: PrPlan,
		included: readonly PrPlanItem[],
		edits: ReadonlyMap<string, PlannedEdit>,
		snapshot: readonly RepoFile[],
		index: ManifestIndex | null,
		ecosystem: Ecosystem,
		manager: PackageManager
	): Promise<CommitPlan> {
		const byPath = new Map(snapshot.map((file) => [file.path, file]));
		const files: RepoFile[] = [];

		// Several bumps can land in the same file — a monorepo rewriting two
		// catalog entries edits the root manifest twice — so edits are grouped
		// per path and applied to ONE copy of it.
		type CommitEdit = ManifestRangeEdit & { style?: DeclarationStyle };
		const editsByPath = new Map<string, CommitEdit[]>();
		for (const item of included) {
			if (item.status !== 'changesManifest') continue;
			const planned = edits.get(
				`${item.workspace}${NUL}${item.packageName}`
			);
			// The fetched manifest has the last word on WHERE the edit goes,
			// even if the plan was drawn up without it (unreachable repo): a
			// stale plan must never write a semver range over `catalog:`.
			const declaration = index?.declaration(
				item.workspace,
				item.packageName
			);
			const path =
				declaration?.editPath ?? planned?.path ?? item.manifestPath;
			const catalogGroup =
				declaration?.catalogGroup ?? planned?.catalogGroup;
			const style = declaration?.style ?? planned?.style;
			const edit: CommitEdit = {
				packageName: item.packageName,
				newRange: item.newRange as string,
				...(catalogGroup === undefined ? {} : { catalogGroup }),
				...(style === undefined ? {} : { style }),
			};
			const bucket = editsByPath.get(path);
			if (bucket === undefined) editsByPath.set(path, [edit]);
			else bucket.push(edit);
		}

		for (const [path, pathEdits] of editsByPath) {
			const source = byPath.get(path);
			if (source === undefined) {
				throw new GithubError(
					`${path} was not found on ${prPlan.baseBranch}`
				);
			}
			const result =
				ecosystem === 'npm'
					? applyRangeEdits(source.content, pathEdits)
					: applyPypiRangeEdits(
							source.content,
							pathEdits.map((edit) => ({
								packageName: edit.packageName,
								newRange: edit.newRange,
								style: edit.style ?? 'pep621',
							})),
							basenameOf(path) === 'requirements.txt'
								? 'requirements'
								: 'pyproject'
						);
			if (result.applied.length === 0) {
				throw new InvalidInputError(
					`none of the selected packages are declared in ${path}`
				);
			}
			if (result.content !== source.content) {
				files.push({ path, content: result.content });
			}
		}

		let lockfileUpdated = false;
		let lockfileNote = prPlan.lockfileNote;

		if (prPlan.lockfileRegenPlanned) {
			const lockName = LOCKFILE_NAMES[manager];
			const lockPath =
				lockName === undefined
					? undefined
					: (index?.pathAtRoot(lockName) ?? lockName);
			const lockfile =
				lockPath === undefined ? undefined : byPath.get(lockPath);
			if (lockfile === undefined) {
				lockfileNote = `${lockName ?? 'lockfile'} was not found on ${prPlan.baseBranch}`;
			} else {
				// EVERY manifest goes into the sandbox, carrying this PR's
				// edits where it has one. A workspaces repo only resolves
				// correctly — and `catalog:` only resolves at all — when the
				// installer can see the whole set.
				const edited = new Map(files.map((file) => [file.path, file]));
				const manifests = snapshot
					.filter(
						(file) =>
							basenameOf(file.path) ===
								MANIFEST_BASENAME[ecosystem] &&
							!file.path.includes('node_modules/')
					)
					.map((file) => edited.get(file.path) ?? file);
				// `install --lockfile-only` keeps every already-locked version
				// that still satisfies its range, so an in-range bump needs the
				// targeted `update` command instead.
				const updateTargets = [
					...new Set(
						included
							.filter((item) => item.status === 'lockfileOnly')
							.map((item) => item.packageName)
					),
				];
				if (manifests.length === 0) {
					lockfileNote = `no root ${MANIFEST_BASENAME[ecosystem]} was found`;
				} else {
					const regenerated = await regenerate({
						manager,
						manifests,
						lockfile,
						updateTargets,
					});
					if (regenerated.ok) {
						files.push({
							path: lockfile.path,
							content: regenerated.content,
						});
						lockfileUpdated = true;
						lockfileNote = null;
					} else {
						lockfileNote = regenerated.reason;
						log?.info('lockfile regeneration skipped', {
							projectId: project.id,
							reason: regenerated.reason,
						});
					}
				}
			}
		}

		return { files, lockfileUpdated, lockfileNote };
	}

	async function create(
		projectId: string,
		selections: readonly PrSelectionInput[],
		options: CreatePrOptions
	): Promise<CreatePrResult> {
		const {
			plan: prPlan,
			edits,
			snapshot,
		} = await planInternal(projectId, selections);
		const included = prPlan.items.filter(
			(item) => item.status !== 'dropped'
		);
		if (included.length === 0) {
			const reasons = [
				...new Set(
					prPlan.items
						.map((item) => item.reason)
						.filter((reason): reason is string => reason !== null)
				),
			];
			throw new InvalidInputError(
				`No dependency in this selection can be bumped. ${reasons.join('; ')}`
			);
		}
		if (prPlan.alreadyOpenPr !== null) {
			const row = await deps.pullRequests.byId(prPlan.alreadyOpenPr.id);
			if (row !== null) throw alreadyOpen(row);
		}

		const project = await deps.projects.get(projectId);
		if (project === null) throw new NotFoundError('Project', projectId);

		const bumps: PullRequestBumpInput[] = included.map((item) => ({
			packageName: item.packageName,
			workspace: item.workspace,
			fromRange: item.fromRange,
			fromVersion: item.fromVersion,
			toVersion: item.toVersion as string,
			advisoryId: item.advisories[0]?.advisoryId ?? null,
			findingId: item.advisories[0]?.findingId ?? null,
		}));

		// The row goes in BEFORE any GitHub write: `uniqueIndex(projectId,
		// branch)` is the second dedupe line, and it only defends us if the
		// claim is staked first.
		const row = await deps.pullRequests.createPending({
			projectId: project.id,
			branch: prPlan.branch,
			baseBranch: prPlan.baseBranch,
			kind: options.kind,
			title: prPlan.title,
			createdByUserId: options.actorUserId ?? null,
			bumps,
		});
		if (row === null) {
			const existing = await deps.pullRequests.byBranch(
				project.id,
				prPlan.branch
			);
			if (existing !== null) throw alreadyOpen(existing);
			throw new GithubError(
				'pull request bookkeeping collided with itself'
			);
		}

		try {
			const result = await openOnGithub(
				project,
				prPlan,
				included,
				edits,
				snapshot,
				row
			);
			return result;
		} catch (error) {
			await deps.pullRequests.markFailed(row.id, messageOf(error));
			log?.error('pull request creation failed', {
				projectId: project.id,
				pullRequestId: row.id,
				branch: prPlan.branch,
				error: messageOf(error),
			});
			if (
				error instanceof InvalidInputError ||
				error instanceof PrAlreadyOpenError ||
				error instanceof NotFoundError
			) {
				throw error;
			}
			throw error instanceof GithubError
				? error
				: new GithubError(messageOf(error));
		}
	}

	async function openOnGithub(
		project: ProjectRow,
		prPlan: PrPlan,
		included: readonly PrPlanItem[],
		edits: ReadonlyMap<string, PlannedEdit>,
		planned: PlanSnapshot | null,
		row: PullRequestRow
	): Promise<CreatePrResult> {
		const token = await deps.github.resolveToken(project);
		const { client, reader } = deps.github.forToken(token);
		const writer = createPrWriter(client);
		const target: RepoTarget = {
			owner: project.owner,
			repo: project.repo,
		};

		const setInfo = await setInfoFor(project);

		// `plan` already read the base branch seconds ago, and the classification
		// it produced is only valid against THOSE bytes — re-fetching here could
		// silently edit a manifest the plan never saw. The fetch below is the
		// fallback for a plan that could not reach GitHub at all.
		const base =
			planned ??
			(await (async (): Promise<PlanSnapshot> => {
				const branch =
					prPlan.baseBranch === ''
						? await reader.resolveBranch({ ...target, branch: '' })
						: prPlan.baseBranch;
				const fetched = await reader.snapshot(
					{ ...target, branch },
					parseJsonArray(project.manifestPathsJson)
				);
				return {
					branch,
					files: fetched.files,
					index: buildIndexFor(
						setInfo.ecosystem,
						setInfo.manager,
						fetched.files
					),
				};
			})());
		const baseBranch = base.branch;

		const commit = await buildCommitFiles(
			project,
			{ ...prPlan, baseBranch },
			included,
			edits,
			base.files,
			base.index,
			setInfo.ecosystem,
			setInfo.manager
		);
		if (commit.files.length === 0) {
			// Every included bump was `lockfileOnly` and the lockfile did not
			// move. Say WHICH of the three causes it was — a bare "no file
			// changes" leaves the user with nothing to act on.
			throw new InvalidInputError(
				`The selected bumps produce no file changes on ${baseBranch}: their declared ranges already allow the target versions, so only ${LOCKFILE_NAMES[setInfo.manager] ?? 'the lockfile'} could change — and it did not (${commit.lockfileNote ?? 'no reason was recorded'}).`
			);
		}

		const baseSha = await writer.getRef(target, baseBranch);
		await writer.ensureBranch(target, prPlan.branch, baseSha);
		const { treeSha: baseTreeSha } = await writer.getCommit(
			target,
			baseSha
		);

		const treeFiles = [];
		for (const file of commit.files) {
			const sha = await writer.createBlob(target, file.content);
			treeFiles.push({ path: file.path, sha });
		}
		const treeSha = await writer.createTree(target, baseTreeSha, treeFiles);
		const commitSha = await writer.createCommit(target, {
			message: `${prPlan.title}\n\nOpened by understory.`,
			treeSha,
			parentSha: baseSha,
		});
		await writer.updateRef(target, prPlan.branch, commitSha);

		const body = bodyFor({
			projectName: project.name,
			appUrl: deps.config.appUrl,
			items: included,
			counts: prPlan.severityCounts,
			lockfileUpdated: commit.lockfileUpdated,
			lockfileNote: commit.lockfileNote,
			manager: setInfo.manager,
		});
		const pull = await writer.openPull(target, {
			title: prPlan.title,
			head: prPlan.branch,
			base: baseBranch,
			body,
		});

		const labels = parseJsonArray(project.prLabelsJson) ?? [];
		if (labels.length > 0) {
			await writer.addLabels(target, pull.number, labels);
		}

		await deps.pullRequests.markOpen(row.id, {
			number: pull.number,
			url: pull.url,
			commitSha,
			lockfileUpdated: commit.lockfileUpdated,
		});

		const bumpRows = await deps.pullRequests.bumpsFor([row.id]);
		await dispatchSafely({
			type: 'pr_opened',
			projectId: project.id,
			projectName: project.name,
			pullRequestId: row.id,
			number: pull.number,
			title: prPlan.title,
			url: pull.url,
			branch: prPlan.branch,
			kind: row.kind,
			bumps: toBumpSummaries(bumpRows.get(row.id) ?? []),
		});

		return {
			id: row.id,
			number: pull.number,
			url: pull.url,
			branch: prPlan.branch,
			lockfileUpdated: commit.lockfileUpdated,
		};
	}

	async function setInfoFor(
		project: ProjectRow
	): Promise<{ ecosystem: Ecosystem; manager: PackageManager }> {
		if (project.lastSuccessScanId === null) {
			return { ecosystem: 'npm', manager: 'npm' };
		}
		const scan = await deps.scans.get(project.lastSuccessScanId);
		if (scan?.dependencySetId == null) {
			return { ecosystem: 'npm', manager: 'npm' };
		}
		const setRow = await deps.dependencySets.byId(scan.dependencySetId);
		return {
			ecosystem: setRow?.ecosystem ?? 'npm',
			manager: setRow?.manager ?? 'npm',
		};
	}

	/** Notifications must never take a PR down with them. */
	async function dispatchSafely(
		event: PrOpenedEvent | PrMergedEvent
	): Promise<void> {
		try {
			await deps.dispatchEvent(event);
		} catch (error) {
			log?.warn('pull request notification failed', {
				pullRequestId: event.pullRequestId,
				error: messageOf(error),
			});
		}
	}

	/* ------------------------------------------------------------------ */
	/* Sync                                                                */
	/* ------------------------------------------------------------------ */

	async function syncOne(
		row: PullRequestRow,
		project: ProjectRow | null
	): Promise<boolean> {
		if (project === null) return false;

		if (row.number === null) {
			// No PR number means `openOnGithub` never got that far. After the
			// grace period the row is a tombstone, not work in progress.
			const age = clock().getTime() - row.createdAt.getTime();
			if (age > CREATING_TIMEOUT_MS) {
				await deps.pullRequests.markFailed(
					row.id,
					'pull request creation never completed'
				);
				return true;
			}
			return false;
		}

		const token = await deps.github.resolveToken(project);
		const { client } = deps.github.forToken(token);
		const writer = createPrWriter(client);
		const pull = await writer.getPull(
			{ owner: project.owner, repo: project.repo },
			row.number
		);
		if (pull === null) {
			await deps.pullRequests.markSynced(row.id, {
				state: 'closed',
				closedAt: clock(),
			});
			return true;
		}

		if (pull.merged) {
			await deps.pullRequests.markSynced(row.id, {
				state: 'merged',
				mergedAt: pull.mergedAt ?? clock(),
				closedAt: pull.closedAt,
			});
			const bumps = await deps.pullRequests.bumpsFor([row.id]);
			await dispatchSafely({
				type: 'pr_merged',
				projectId: project.id,
				projectName: project.name,
				pullRequestId: row.id,
				number: row.number,
				title: row.title,
				url: row.url ?? pull.url,
				branch: row.branch,
				kind: row.kind,
				bumps: toBumpSummaries(bumps.get(row.id) ?? []),
			});
			return true;
		}

		if (pull.state === 'closed') {
			await deps.pullRequests.markSynced(row.id, {
				state: 'closed',
				closedAt: pull.closedAt ?? clock(),
			});
			return true;
		}

		if (row.state !== 'open') {
			await deps.pullRequests.markSynced(row.id, {
				state: 'open',
				url: pull.url,
			});
			return true;
		}

		await deps.pullRequests.touchSynced(row.id);
		return false;
	}

	async function syncOpen(): Promise<{
		checked: number;
		transitioned: number;
	}> {
		const rows = await deps.pullRequests.listActive();
		const projects = new Map<string, ProjectRow | null>();
		let transitioned = 0;

		for (const row of rows) {
			try {
				if (!projects.has(row.projectId)) {
					projects.set(
						row.projectId,
						await deps.projects.get(row.projectId)
					);
				}
				const changed = await syncOne(
					row,
					projects.get(row.projectId) ?? null
				);
				if (changed) transitioned += 1;
			} catch (error) {
				// One unreachable repo must not stall the rest of the queue.
				log?.warn('pull request sync failed', {
					pullRequestId: row.id,
					error: messageOf(error),
				});
			}
		}

		return { checked: rows.length, transitioned };
	}

	async function syncOneById(pullRequestId: string): Promise<PullRequestRow> {
		const row = await deps.pullRequests.byId(pullRequestId);
		if (row === null) {
			throw new NotFoundError('PullRequest', pullRequestId);
		}
		if (row.state === 'creating' || row.state === 'open') {
			const project = await deps.projects.get(row.projectId);
			try {
				await syncOne(row, project);
			} catch (error) {
				throw new GithubError(messageOf(error));
			}
		}
		return (await deps.pullRequests.byId(pullRequestId)) ?? row;
	}

	/* ------------------------------------------------------------------ */
	/* Auto-PR port                                                        */
	/* ------------------------------------------------------------------ */

	/**
	 * The scan service has already filtered by severity and bump size; what is
	 * left is one selection per FINDING, so the same package can appear several
	 * times with different fix targets. One PR per package at the highest
	 * required version is the only shape that actually resolves them all.
	 */
	const autoPr: AutoPrPort = {
		async maybeCreate(input: AutoPrInput): Promise<void> {
			try {
				const grouped = new Map<string, PrSelectionInput>();
				for (const selection of input.selections) {
					const key = `${selection.workspace}${NUL}${selection.packageName}`;
					const current = grouped.get(key);
					if (
						current === undefined ||
						current.toVersion === undefined ||
						isNewerVersion(selection.toVersion, current.toVersion)
					) {
						grouped.set(key, {
							name: selection.packageName,
							workspace: selection.workspace,
							toVersion: selection.toVersion,
						});
					}
				}
				if (grouped.size === 0) return;

				const created = await create(
					input.projectId,
					[...grouped.values()],
					{ kind: 'auto_security' }
				);
				log?.info('auto security pull request opened', {
					projectId: input.projectId,
					scanId: input.scanId,
					number: created.number,
					url: created.url,
				});
			} catch (error) {
				if (error instanceof PrAlreadyOpenError) {
					log?.info('auto security pull request already open', {
						projectId: input.projectId,
						scanId: input.scanId,
						url: error.pullRequest.url,
					});
					return;
				}
				if (error instanceof InvalidInputError) {
					log?.info(
						'auto security pull request had nothing to bump',
						{
							projectId: input.projectId,
							scanId: input.scanId,
							reason: error.message,
						}
					);
					return;
				}
				// The scan already succeeded; a failed PR attempt is recorded on
				// the row and must never surface as a scan failure.
				log?.warn('auto security pull request failed', {
					projectId: input.projectId,
					scanId: input.scanId,
					error: messageOf(error),
				});
			}
		},

		async maybeCreateBumps(input): Promise<void> {
			try {
				if (input.selections.length === 0) return;

				// One auto-update PR at a time: version bumps trickle in with
				// every scan, and without this guard each new `latest` would
				// open another PR. A fresh one only opens after the previous
				// merges or closes.
				const active = await deps.pullRequests.listForProject(
					input.projectId,
					{ state: ['creating', 'open'], page: 1, pageSize: 50 }
				);
				const openBump = active.items.find(
					(item) => item.pullRequest.kind === 'auto_update'
				);
				if (openBump !== undefined) {
					log?.info('auto update pull request already open', {
						projectId: input.projectId,
						scanId: input.scanId,
						url: openBump.pullRequest.url,
					});
					return;
				}

				const created = await create(
					input.projectId,
					input.selections.map((selection) => ({
						name: selection.packageName,
						workspace: selection.workspace,
						toVersion: selection.toVersion,
					})),
					{ kind: 'auto_update' }
				);
				log?.info('auto update pull request opened', {
					projectId: input.projectId,
					scanId: input.scanId,
					number: created.number,
					url: created.url,
				});
			} catch (error) {
				if (error instanceof PrAlreadyOpenError) {
					log?.info('auto update pull request already covered', {
						projectId: input.projectId,
						scanId: input.scanId,
						url: error.pullRequest.url,
					});
					return;
				}
				if (error instanceof InvalidInputError) {
					log?.info('auto update pull request had nothing to bump', {
						projectId: input.projectId,
						scanId: input.scanId,
						reason: error.message,
					});
					return;
				}
				log?.warn('auto update pull request failed', {
					projectId: input.projectId,
					scanId: input.scanId,
					error: messageOf(error),
				});
			}
		},
	};

	return { plan, create, syncOpen, syncOneById, autoPr };
}

export type PrService = ReturnType<typeof createPrService>;
