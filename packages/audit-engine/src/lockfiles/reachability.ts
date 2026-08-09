/**
 * Reachability tagging for lockfiles that record a flat package table without
 * per-entry `dev` / `optional` flags (pnpm v9, yarn v1, yarn berry).
 *
 * npm's `package-lock.json` stamps every entry with `dev`/`optional`, so it can
 * read the answer straight off the file. The others cannot: a package is a dev
 * dependency only because *every* path that reaches it starts in a
 * `devDependencies` block. That is a graph property, so it is computed here by
 * walking outward from the declared roots and keeping the strongest tag (and
 * the shallowest depth) that reaches each node.
 */

export type ReachTag = 'prod' | 'optional' | 'dev';

/** Lower wins: something reachable in production is production, whatever else also reaches it. */
const TAG_RANK: Record<ReachTag, number> = { prod: 0, optional: 1, dev: 2 };

export interface ReachRoot<K> {
	key: K;
	tag: ReachTag;
}

export interface ReachEdges<K> {
	/** Regular dependency edges — the tag flows through unchanged. */
	deps: readonly K[];
	/** Optional edges — a `prod` walker downgrades to `optional` across them. */
	optionalDeps: readonly K[];
}

export interface Reached {
	tag: ReachTag;
	/** Edges traversed from the nearest root; roots themselves are `1`. */
	depth: number;
}

/**
 * Breadth-first walk from `roots`. BFS (not DFS) so the first visit of a node
 * is already its minimal depth; a node is only re-queued when a *stronger* tag
 * reaches it, which is what keeps a dev-first traversal from freezing a package
 * that production also depends on.
 */
export function walkReachable<K>(
	roots: readonly ReachRoot<K>[],
	edgesOf: (key: K) => ReachEdges<K> | undefined
): Map<K, Reached> {
	const reached = new Map<K, Reached>();
	const queue: { key: K; tag: ReachTag; depth: number }[] = [];

	const visit = (key: K, tag: ReachTag, depth: number): void => {
		const existing = reached.get(key);
		if (existing === undefined) {
			reached.set(key, { tag, depth });
			queue.push({ key, tag, depth });
			return;
		}
		const better = TAG_RANK[tag] < TAG_RANK[existing.tag];
		if (depth < existing.depth) existing.depth = depth;
		if (!better) return;
		existing.tag = tag;
		queue.push({ key, tag, depth });
	};

	for (const root of roots) visit(root.key, root.tag, 1);

	for (let head = 0; head < queue.length; head++) {
		const current = queue[head];
		if (current === undefined) continue;
		const edges = edgesOf(current.key);
		if (edges === undefined) continue;
		for (const next of edges.deps) {
			visit(next, current.tag, current.depth + 1);
		}
		for (const next of edges.optionalDeps) {
			// An optional edge can only weaken a production walker; a dev walker
			// stays dev (the package is still only needed for development).
			visit(
				next,
				current.tag === 'prod' ? 'optional' : current.tag,
				current.depth + 1
			);
		}
	}

	return reached;
}

/** `dev`/`optional`/`peer` declarations map onto the three reachability tags. */
export function tagForDepType(
	depType: 'prod' | 'dev' | 'peer' | 'optional' | 'peer_optional'
): ReachTag {
	if (depType === 'dev') return 'dev';
	if (depType === 'optional') return 'optional';
	return 'prod';
}
