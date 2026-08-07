import type { LoggerPort } from '@declarativejs/core';
import {
	ECOSYSTEMS,
	ecosystemFor,
	mergeAdvisories,
	normalizeOsvVuln,
	type OsvClient,
	type OsvVuln,
} from '@workspace/audit-engine';
import type { AdvisoriesStore } from '../stores/advisories';
import type { FindingsStore } from '../stores/findings';
import { mapWithConcurrency } from './scan-service';

const OSV_DETAIL_CONCURRENCY = 5;

export interface AdvisoryRefreshDeps {
	advisories: AdvisoriesStore;
	findings: FindingsStore;
	osv: OsvClient;
	log?: LoggerPort;
}

export interface AdvisoryRefreshResult {
	/** Advisories carrying an OSV source that were examined. */
	checked: number;
	/** Of those, how many had an advanced `modified` and were re-fetched + merged. */
	refreshed: number;
	/** Open findings resolved because their version no longer matches, or the advisory was withdrawn. */
	findingsResolved: number;
	/** Open findings whose `severity` was updated to match a re-evaluated advisory. */
	findingsUpdated: number;
}

export interface AdvisoryRefreshService {
	refresh(now: Date): Promise<AdvisoryRefreshResult>;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface ChangedEntry {
	advisoryId: string;
	vuln: OsvVuln;
}

/**
 * The `advisory.refresh` job's body (§5 of the design doc). Every advisory
 * that carries an OSV source is a candidate; a source whose `modified`
 * timestamp hasn't advanced is skipped without a detail fetch — the same
 * short-circuit the scan pipeline uses for newly-discovered advisories,
 * applied here to ones already on file.
 *
 * Re-evaluation is scoped to advisories that actually changed this run: an
 * advisory nothing said anything new about cannot have caused a finding to
 * stop matching, so there is nothing to re-check.
 */
export function createAdvisoryRefreshService(
	deps: AdvisoryRefreshDeps
): AdvisoryRefreshService {
	return {
		async refresh(now) {
			const sources = await deps.advisories.advisoriesWithSource('osv');
			const checked = sources.length;
			if (checked === 0) {
				return {
					checked: 0,
					refreshed: 0,
					findingsResolved: 0,
					findingsUpdated: 0,
				};
			}

			const known = await deps.advisories.getSourceModified(
				sources.map((source) => source.sourceId)
			);

			const staleResults = await mapWithConcurrency(
				sources,
				OSV_DETAIL_CONCURRENCY,
				async (source): Promise<ChangedEntry | null> => {
					try {
						const vuln = await deps.osv.getVuln(source.sourceId);
						const stored = known.get(source.sourceId) ?? null;
						const changed =
							stored === null ||
							(vuln.modified !== undefined &&
								stored.getTime() !== Date.parse(vuln.modified));
						return changed
							? { advisoryId: source.advisoryId, vuln }
							: null;
					} catch (error) {
						deps.log?.warn('advisory.refresh: OSV fetch failed', {
							sourceId: source.sourceId,
							error: messageOf(error),
						});
						return null;
					}
				}
			);
			const changed = staleResults.filter(
				(entry): entry is ChangedEntry => entry !== null
			);

			if (changed.length === 0) {
				return {
					checked,
					refreshed: 0,
					findingsResolved: 0,
					findingsUpdated: 0,
				};
			}

			// One OSV record can affect several ecosystems; normalize once per
			// ecosystem and let the merge union the (ecosystem-tagged) ranges.
			const normalized = changed.flatMap((entry) =>
				ECOSYSTEMS.map((port) =>
					normalizeOsvVuln(entry.vuln, { ecosystem: port.ecosystem })
				)
			);
			const merged = mergeAdvisories([normalized]);
			if (merged.length > 0) await deps.advisories.upsertMerged(merged);

			// Replace ranges outright for what we just re-fetched (see the
			// method's doc comment): `upsertMerged` only ever adds, and a
			// refresh's whole point is to let a narrowed/removed upstream range
			// actually narrow or disappear here.
			for (const mergedAdvisory of merged) {
				const resolved =
					(await deps.advisories.advisoryById(mergedAdvisory.id))
						?.advisory.id ?? mergedAdvisory.id;
				await deps.advisories.replaceRangesForAdvisory(
					resolved,
					mergedAdvisory.ranges
				);
			}

			let findingsResolved = 0;
			let findingsUpdated = 0;

			for (const entry of changed) {
				// Resolved through the alias table, so this reflects the merge
				// above even if `entry.advisoryId`'s canonical id shifted.
				const detail = await deps.advisories.advisoryById(
					entry.advisoryId
				);
				if (detail === null) continue;

				const openFindings = await deps.findings.openForAdvisoryIds([
					entry.advisoryId,
				]);
				if (openFindings.length === 0) continue;

				const resolveIds: string[] = [];
				const severityUpdateIds: string[] = [];

				for (const finding of openFindings) {
					if (detail.advisory.withdrawnAt !== null) {
						resolveIds.push(finding.id);
						continue;
					}
					// Each stored range carries its ecosystem; evaluate it with
					// that ecosystem's own version semantics.
					const stillMatches = detail.ranges
						.filter(
							(range) => range.packageName === finding.packageName
						)
						.some((range) =>
							ecosystemFor(range.ecosystem).versioning.satisfies(
								finding.packageVersion,
								range.vulnerableRange
							)
						);
					if (!stillMatches) {
						resolveIds.push(finding.id);
					} else if (finding.severity !== detail.advisory.severity) {
						severityUpdateIds.push(finding.id);
					}
				}

				if (resolveIds.length > 0) {
					findingsResolved += await deps.findings.resolveByIds(
						resolveIds,
						now
					);
				}
				if (severityUpdateIds.length > 0) {
					findingsUpdated += await deps.findings.updateSeverity(
						severityUpdateIds,
						detail.advisory.severity
					);
				}
			}

			return {
				checked,
				refreshed: changed.length,
				findingsResolved,
				findingsUpdated,
			};
		},
	};
}
