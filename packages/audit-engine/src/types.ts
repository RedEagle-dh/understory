/**
 * Shared domain types for `@workspace/audit-engine`.
 *
 * Everything in this package is pure: no database access, no framework
 * imports. The only I/O is performed by the registry / OSV clients, and even
 * those receive their `fetch` implementation by injection.
 */

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

/** A repository file as fetched by the scan service. */
export interface FileEntry {
	/** Repo-relative POSIX path, e.g. `apps/web/package.json`. */
	path: string;
	content: string;
}

/* -------------------------------------------------------------------------- */
/* Dependency graph                                                           */
/* -------------------------------------------------------------------------- */

export type PackageManager = 'npm' | 'bun' | 'yarn' | 'pnpm';

export type DepType = 'prod' | 'dev' | 'peer' | 'optional' | 'peer_optional';

/** How a declared range should be interpreted. */
export type RangeKind =
	| 'semver'
	| 'tag'
	| 'wildcard'
	| 'workspace'
	| 'catalog'
	| 'alias'
	| 'file'
	| 'link'
	| 'git'
	| 'url'
	| 'unknown';

export interface PeerRequirement {
	range: string;
	optional: boolean;
}

export interface ParsedDependency {
	name: string;
	version: string;
	/** Workspace directory the dependency belongs to. `''` is the repo root. */
	workspace: string;
	depType: DepType;
	isDirect: boolean;
	/** `0` for direct dependencies, otherwise the `node_modules` nesting depth. */
	depth: number;
	/** Only present for direct dependencies. */
	declaredRange?: string;
	/** The range exactly as written in package.json (before catalog resolution). */
	rawRange?: string;
	/** Peer requirements declared *by* this package. */
	peerDeps?: Record<string, PeerRequirement>;
	/** Resolved tarball URL / lockfile `resolved` value when available. */
	resolved?: string;
	/** Deprecation message, when the lockfile or packument exposes one. */
	deprecated?: string;
}

export interface DependencyGraph {
	manager: PackageManager;
	/** Workspace paths, including `''` for the repo root. */
	workspaces: string[];
	/** Deduped by `(workspace, name, version, depType)`. */
	dependencies: ParsedDependency[];
	warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Manifests                                                                  */
/* -------------------------------------------------------------------------- */

export interface DeclaredDependency {
	name: string;
	/** Range after catalog resolution (identical to `rawRange` when no catalog). */
	range: string;
	/** Range exactly as written in the manifest. */
	rawRange: string;
	rangeKind: RangeKind;
	depType: DepType;
}

export interface WorkspaceManifest {
	/** Workspace directory; `''` for the repo root. */
	path: string;
	/** Path of the package.json the data came from. */
	manifestPath: string;
	isRoot: boolean;
	name?: string;
	version?: string;
	packageManager?: string;
	/** Every declaration, including duplicates across dependency sections. */
	deps: DeclaredDependency[];
	/** One declaration per name, resolved by precedence prod > dev > optional > peer. */
	byName: Map<string, DeclaredDependency>;
}

export interface ManifestSet {
	root?: WorkspaceManifest;
	/** All workspaces including the root, ordered root-first. */
	workspaces: WorkspaceManifest[];
	byPath: Map<string, WorkspaceManifest>;
	/** Root `catalog` field (bun/pnpm default catalog). */
	catalog?: Record<string, string>;
	/** Root `catalogs` field (named catalog groups). */
	catalogs?: Record<string, Record<string, string>>;
	warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Advisories                                                                 */
/* -------------------------------------------------------------------------- */

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

export type AdvisorySource = 'npm' | 'osv';

export interface AdvisoryRange {
	packageName: string;
	/** A semver range string, e.g. `>=4.0.0 <4.17.21`. */
	vulnerableRange: string;
	firstPatched?: string;
}

export interface NormalizedAdvisory {
	/** Canonical identifier: GHSA > CVE > source id. */
	id: string;
	/** Every other known identifier (CVEs, `npm:<numericId>`, OSV/GHSA ids). */
	aliases: string[];
	source: AdvisorySource;
	sourceId: string;
	sourceModifiedAt?: string;
	summary: string;
	details?: string;
	severity: Severity;
	cvssScore?: number;
	cvssVector?: string;
	cweIds: string[];
	url?: string;
	publishedAt?: string;
	modifiedAt?: string;
	withdrawnAt?: string;
	ranges: AdvisoryRange[];
	raw: unknown;
}

export interface AdvisorySourceRef {
	source: AdvisorySource;
	sourceId: string;
	sourceModifiedAt?: string;
	url?: string;
}

/** Result of {@link mergeAdvisories}: one row per canonical advisory. */
export interface MergedAdvisory extends NormalizedAdvisory {
	/** Every source that contributed to this advisory. */
	sources: AdvisorySourceRef[];
}

/* -------------------------------------------------------------------------- */
/* npm registry payloads                                                      */
/* -------------------------------------------------------------------------- */

export interface PackumentVersion {
	name?: string;
	version: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	optionalDependencies?: Record<string, string>;
	dist?: { tarball?: string; integrity?: string; shasum?: string };
	deprecated?: string;
	engines?: Record<string, string>;
	hasInstallScript?: boolean;
}

export interface Packument {
	name: string;
	'dist-tags': Record<string, string>;
	versions: Record<string, PackumentVersion>;
	modified?: string;
	time?: Record<string, string>;
}

export type DistTags = Record<string, string>;

/** One entry of the npm bulk advisory endpoint response. */
export interface NpmBulkAdvisory {
	id: number;
	url?: string;
	title?: string;
	severity?: string;
	vulnerable_versions?: string;
	cwe?: string[];
	cves?: string[];
	cvss?: { score?: number; vectorString?: string };
	[key: string]: unknown;
}

export type NpmBulkAdvisoryResponse = Record<string, NpmBulkAdvisory[]>;

/* -------------------------------------------------------------------------- */
/* OSV payloads                                                               */
/* -------------------------------------------------------------------------- */

export interface OsvEvent {
	introduced?: string;
	fixed?: string;
	last_affected?: string;
	limit?: string;
}

export interface OsvRange {
	type?: string;
	repo?: string;
	events?: OsvEvent[];
	database_specific?: Record<string, unknown>;
}

export interface OsvAffected {
	package?: { name?: string; ecosystem?: string; purl?: string };
	ranges?: OsvRange[];
	versions?: string[];
	severity?: OsvSeverity[];
	database_specific?: Record<string, unknown>;
	ecosystem_specific?: Record<string, unknown>;
}

export interface OsvSeverity {
	type?: string;
	/** For CVSS types this is the *vector string*, not a numeric score. */
	score?: string;
}

export interface OsvVuln {
	id: string;
	aliases?: string[];
	related?: string[];
	summary?: string;
	details?: string;
	severity?: OsvSeverity[];
	affected?: OsvAffected[];
	references?: { type?: string; url?: string }[];
	database_specific?: {
		severity?: string;
		cwe_ids?: string[];
		[key: string]: unknown;
	};
	published?: string;
	modified?: string;
	withdrawn?: string;
}

export interface OsvVulnRef {
	id: string;
	modified?: string;
}

/** One `results[]` entry of `/v1/querybatch`, normalized (`{}` becomes `vulns: []`). */
export interface OsvBatchResult {
	vulns: OsvVulnRef[];
	nextPageToken?: string;
}

/* -------------------------------------------------------------------------- */
/* Computation results                                                        */
/* -------------------------------------------------------------------------- */

export type UpdateKind = 'none' | 'patch' | 'minor' | 'major';

export type FixType = 'none' | 'patch' | 'minor' | 'major';

export interface PeerIssue {
	packageName: string;
	requiredBy: string;
	requiredByVersion: string;
	requiredRange: string;
	resolvedVersion?: string;
	kind: 'missing' | 'invalid';
	optional: boolean;
	/** Workspace the requiring package lives in (`''` = root). */
	workspace: string;
}
