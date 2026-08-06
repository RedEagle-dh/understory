/**
 * `@workspace/audit-engine` — pure domain logic for the dependency audit
 * viewer: lockfile parsing, registry/OSV clients, advisory normalization and
 * merging, and the outdated / fix / peer / bump computations.
 *
 * No database access, no framework imports. The two HTTP clients receive their
 * `fetch` implementation by injection, so nothing here touches the network on
 * its own.
 */

export * from './advisories/merge';
export * from './advisories/normalize-npm';
export * from './advisories/severity';
export * from './bump-plan';
export * from './fix';
export * from './lockfiles';
export * from './osv/client';
export * from './osv/normalize';
export * from './outdated';
export * from './peers';
export * from './ranges';
export * from './registry/cache';
export * from './registry/npm-client';
export * from './types';
