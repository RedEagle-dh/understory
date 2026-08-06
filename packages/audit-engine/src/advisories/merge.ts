import type {
	AdvisoryRange,
	AdvisorySourceRef,
	MergedAdvisory,
	NormalizedAdvisory,
} from '../types';
import { compareSeverity } from './severity';

const GHSA_ID = /^GHSA-/i;
const CVE_ID = /^CVE-\d{4}-\d{4,}$/i;

/** GHSA (0) beats CVE (1) beats everything else (2). */
function idRank(id: string): number {
	if (GHSA_ID.test(id)) return 0;
	if (CVE_ID.test(id)) return 1;
	return 2;
}

class DisjointSet {
	private readonly parent = new Map<string, string>();

	find(id: string): string {
		const parent = this.parent.get(id);
		if (parent === undefined) {
			this.parent.set(id, id);
			return id;
		}
		if (parent === id) return id;
		const root = this.find(parent);
		this.parent.set(id, root);
		return root;
	}

	union(a: string, b: string): void {
		const rootA = this.find(a);
		const rootB = this.find(b);
		if (rootA !== rootB) this.parent.set(rootB, rootA);
	}
}

function earliest(
	a: string | undefined,
	b: string | undefined
): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return a <= b ? a : b;
}

function latest(
	a: string | undefined,
	b: string | undefined
): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return a >= b ? a : b;
}

/**
 * Merge advisories coming from several sources into one row per real-world
 * vulnerability.
 *
 * Identity is resolved transitively through aliases (a GHSA from npm and a CVE
 * from OSV that share an alias collapse into a single advisory). On conflict:
 * the worst severity wins, ranges are unioned, npm/GitHub prose beats OSV
 * prose, `publishedAt` takes the earliest value and `modifiedAt` the latest.
 */
export function mergeAdvisories(
	batches: readonly (readonly NormalizedAdvisory[])[]
): MergedAdvisory[] {
	const all = batches.flat();
	const dsu = new DisjointSet();

	for (const advisory of all) {
		const ids = [advisory.id, ...advisory.aliases];
		for (const id of ids) dsu.union(advisory.id, id);
	}

	const groups = new Map<string, NormalizedAdvisory[]>();
	const groupIds = new Map<string, Set<string>>();
	const order: string[] = [];

	for (const advisory of all) {
		const root = dsu.find(advisory.id);
		let group = groups.get(root);
		if (group === undefined) {
			group = [];
			groups.set(root, group);
			groupIds.set(root, new Set());
			order.push(root);
		}
		group.push(advisory);
		const ids = groupIds.get(root) as Set<string>;
		for (const id of [advisory.id, ...advisory.aliases]) ids.add(id);
	}

	const merged: MergedAdvisory[] = [];

	for (const root of order) {
		const group = groups.get(root) as NormalizedAdvisory[];
		const ids = [...(groupIds.get(root) as Set<string>)];

		const canonical =
			ids
				.map((id, index) => ({ id, index, rank: idRank(id) }))
				.sort((a, b) => a.rank - b.rank || a.index - b.index)[0]?.id ??
			root;

		// npm/GitHub curates its prose; prefer it over OSV's.
		const preferred =
			group.find((advisory) => advisory.source === 'npm') ??
			(group[0] as NormalizedAdvisory);

		const ranges: AdvisoryRange[] = [];
		const rangeKeys = new Set<string>();
		const cweIds = new Set<string>();
		const sources: AdvisorySourceRef[] = [];
		const sourceKeys = new Set<string>();

		let severity = preferred.severity;
		let publishedAt: string | undefined;
		let modifiedAt: string | undefined;
		let withdrawnAt: string | undefined;
		let cvssScore: number | undefined;
		let cvssVector: string | undefined;

		for (const advisory of group) {
			if (compareSeverity(advisory.severity, severity) > 0)
				severity = advisory.severity;
			publishedAt = earliest(publishedAt, advisory.publishedAt);
			modifiedAt = latest(modifiedAt, advisory.modifiedAt);
			withdrawnAt ??= advisory.withdrawnAt;

			for (const cwe of advisory.cweIds) cweIds.add(cwe);

			for (const range of advisory.ranges) {
				const key = `${range.packageName} ${range.vulnerableRange}`;
				if (rangeKeys.has(key)) {
					const existing = ranges.find(
						(candidate) =>
							candidate.packageName === range.packageName &&
							candidate.vulnerableRange === range.vulnerableRange
					);
					if (
						existing !== undefined &&
						existing.firstPatched === undefined
					) {
						existing.firstPatched = range.firstPatched;
					}
					continue;
				}
				rangeKeys.add(key);
				ranges.push({ ...range });
			}

			const sourceKey = `${advisory.source}:${advisory.sourceId}`;
			if (!sourceKeys.has(sourceKey)) {
				sourceKeys.add(sourceKey);
				sources.push({
					source: advisory.source,
					sourceId: advisory.sourceId,
					sourceModifiedAt: advisory.sourceModifiedAt,
					url: advisory.url,
				});
			}

			if (advisory.source === 'npm') {
				cvssScore ??= advisory.cvssScore;
				cvssVector ??= advisory.cvssVector;
			}
		}

		if (cvssScore === undefined) {
			for (const advisory of group) {
				if (advisory.cvssScore !== undefined) {
					cvssScore = advisory.cvssScore;
					cvssVector ??= advisory.cvssVector;
					break;
				}
			}
		}
		if (cvssVector === undefined) {
			cvssVector = group.find(
				(advisory) => advisory.cvssVector !== undefined
			)?.cvssVector;
		}

		const details = group.find(
			(advisory) => advisory.details !== undefined
		)?.details;
		const withDetails =
			preferred.details !== undefined
				? preferred
				: (group.find((a) => a.details) ?? preferred);

		merged.push({
			id: canonical,
			aliases: ids.filter((id) => id !== canonical).sort(),
			source: preferred.source,
			sourceId: preferred.sourceId,
			sourceModifiedAt: preferred.sourceModifiedAt,
			summary: preferred.summary,
			details: withDetails.details ?? details,
			severity,
			cvssScore,
			cvssVector,
			cweIds: [...cweIds].sort(),
			url:
				preferred.url ??
				group.find((advisory) => advisory.url !== undefined)?.url,
			publishedAt,
			modifiedAt,
			withdrawnAt,
			ranges,
			raw: preferred.raw,
			sources,
		});
	}

	return merged;
}
