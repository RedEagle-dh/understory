import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"

export type Severity = "low" | "moderate" | "high" | "critical"
export type FindingState = "open" | "resolved" | "ignored"

export interface VulnsParams {
  severity?: Severity
  state?: FindingState
  direct?: boolean
  hasFix?: boolean
  q?: string
  page: number
  pageSize: number
}

async function fetchVulns(projectId: string, params: VulnsParams) {
  return unwrap(
    await api.api
      .projects({ projectId })
      .vulnerabilities.get({ query: params })
  )
}

/** Findings for a project, filtered/paged server-side (open by default). */
export function vulnsQueryOptions(projectId: string, params: VulnsParams) {
  return queryOptions({
    queryKey: [...qk.vulns(projectId), params] as const,
    queryFn: () => fetchVulns(projectId, params),
    placeholderData: keepPreviousData,
  })
}

export type FindingListItem = Awaited<ReturnType<typeof fetchVulns>>["items"][number]

async function fetchSummary(projectId: string) {
  return unwrap(
    await api.api.projects({ projectId }).vulnerabilities.summary.get()
  )
}

/** Severity + state rollup, used for the summary strip's filter pills. */
export function summaryQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: [...qk.vulns(projectId), "summary"] as const,
    queryFn: () => fetchSummary(projectId),
  })
}

export type VulnSummary = Awaited<ReturnType<typeof fetchSummary>>

async function fetchFinding(findingId: string) {
  return unwrap(await api.api.findings({ findingId }).get())
}

/** One finding with its full advisory (aliases, ranges, sources). */
export function findingQueryOptions(findingId: string) {
  return queryOptions({
    queryKey: qk.finding(findingId),
    queryFn: () => fetchFinding(findingId),
    enabled: findingId !== "",
  })
}

export type FindingDetail = Awaited<ReturnType<typeof fetchFinding>>

interface IgnoreInput {
  findingId: string
  reason: string
  ignoreUntil?: string
}

/** Mutes a finding. Invalidates every vulnerabilities query for the project (list + summary) plus the project rollup shown in the header. */
export function useIgnoreFinding(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ findingId, reason, ignoreUntil }: IgnoreInput) =>
      unwrap(
        await api.api
          .findings({ findingId })
          .ignore.post({ reason, ignoreUntil })
      ),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.vulns(projectId) }),
        queryClient.invalidateQueries({ queryKey: qk.project(projectId) }),
        queryClient.invalidateQueries({
          queryKey: qk.finding(variables.findingId),
        }),
      ])
    },
  })
}

/** Un-mutes a finding. Same invalidation footprint as `useIgnoreFinding`. */
export function useUnignoreFinding(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (findingId: string) =>
      unwrap(await api.api.findings({ findingId }).ignore.delete()),
    onSuccess: async (_data, findingId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.vulns(projectId) }),
        queryClient.invalidateQueries({ queryKey: qk.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: qk.finding(findingId) }),
      ])
    },
  })
}
