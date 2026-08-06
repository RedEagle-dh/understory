import { isSemverRange, satisfiesRange } from './ranges';
import type { DependencyGraph, PeerIssue } from './types';

export interface CheckPeersOptions {
	/**
	 * Missing *optional* peers are normal (nobody installs `@types/react` for a
	 * library that merely tolerates it), so they are omitted by default.
	 * Optional peers that resolve to an *incompatible* version are always
	 * reported, with `optional: true`.
	 */
	includeMissingOptional?: boolean;
}

/**
 * Verify that every declared peer requirement resolves in the workspace tree.
 *
 * Resolution looks in the requiring package's own workspace first and then
 * falls back to the hoisted root workspace, which mirrors how npm and bun
 * resolve `node_modules`.
 */
export function checkPeers(
	graph: DependencyGraph,
	options: CheckPeersOptions = {}
): PeerIssue[] {
	const { includeMissingOptional = false } = options;

	// workspace → name → versions present in that workspace.
	const index = new Map<string, Map<string, string[]>>();
	for (const dependency of graph.dependencies) {
		let byName = index.get(dependency.workspace);
		if (byName === undefined) {
			byName = new Map();
			index.set(dependency.workspace, byName);
		}
		const versions = byName.get(dependency.name);
		if (versions === undefined)
			byName.set(dependency.name, [dependency.version]);
		else if (!versions.includes(dependency.version))
			versions.push(dependency.version);
	}

	const resolve = (workspace: string, name: string): string[] => {
		const local = index.get(workspace)?.get(name);
		if (local !== undefined && local.length > 0) return local;
		if (workspace !== '') {
			const hoisted = index.get('')?.get(name);
			if (hoisted !== undefined) return hoisted;
		}
		return [];
	};

	const issues: PeerIssue[] = [];
	const seen = new Set<string>();

	for (const dependency of graph.dependencies) {
		const peers = dependency.peerDeps;
		if (peers === undefined) continue;

		for (const [peerName, requirement] of Object.entries(peers)) {
			const key = [
				dependency.workspace,
				dependency.name,
				dependency.version,
				peerName,
			].join(' ');
			if (seen.has(key)) continue;

			const resolved = resolve(dependency.workspace, peerName);

			if (resolved.length === 0) {
				if (requirement.optional && !includeMissingOptional) continue;
				seen.add(key);
				issues.push({
					packageName: peerName,
					requiredBy: dependency.name,
					requiredByVersion: dependency.version,
					requiredRange: requirement.range,
					kind: 'missing',
					optional: requirement.optional,
					workspace: dependency.workspace,
				});
				continue;
			}

			// Non-semver peer ranges (`workspace:*`, git urls, …) cannot be checked.
			if (!isSemverRange(requirement.range)) continue;

			const satisfied = resolved.some((version) =>
				satisfiesRange(version, requirement.range)
			);
			if (satisfied) continue;

			seen.add(key);
			issues.push({
				packageName: peerName,
				requiredBy: dependency.name,
				requiredByVersion: dependency.version,
				requiredRange: requirement.range,
				resolvedVersion: resolved[0],
				kind: 'invalid',
				optional: requirement.optional,
				workspace: dependency.workspace,
			});
		}
	}

	return issues;
}
