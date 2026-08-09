import { keepPreviousData, queryOptions } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"
import type { FindingState, Severity } from "@/features/vulnerabilities/api"

export interface InboxParams {
  severity?: Severity
  state?: FindingState
  direct?: boolean
  hasFix?: boolean
  kevOnly?: boolean
  projectId?: string
  q?: string
  sort?: "risk" | "severity" | "firstSeen"
  page: number
  pageSize: number
}

async function fetchInbox(params: InboxParams) {
  return unwrap(await api.api.vulnerabilities.get({ query: params }))
}

/** Findings across every project — the triage queue. */
export function inboxQueryOptions(params: InboxParams) {
  return queryOptions({
    queryKey: [...qk.inbox(), params] as const,
    queryFn: () => fetchInbox(params),
    placeholderData: keepPreviousData,
  })
}

export type InboxItem = Awaited<ReturnType<typeof fetchInbox>>["items"][number]

async function fetchInboxSummary() {
  return unwrap(await api.api.vulnerabilities.summary.get())
}

/** Fleet-wide severity rollup, plus the exploited-in-the-wild tally. */
export function inboxSummaryQueryOptions() {
  return queryOptions({
    queryKey: [...qk.inbox(), "summary"] as const,
    queryFn: fetchInboxSummary,
  })
}

export type InboxSummary = Awaited<ReturnType<typeof fetchInboxSummary>>
