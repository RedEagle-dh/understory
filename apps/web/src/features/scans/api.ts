import { keepPreviousData, queryOptions } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"
import { anyScanRunning } from "./lib"

const PAGE_SIZE = 25

async function fetchScans(projectId: string, page: number) {
  return unwrap(
    await api.api
      .projects({ projectId })
      .scans.get({ query: { page, pageSize: PAGE_SIZE } })
  )
}

/** Scan history for a project, newest first. Polls while any listed scan is running. */
export function scansQueryOptions(projectId: string, page: number) {
  return queryOptions({
    queryKey: [...qk.scans(projectId), page] as const,
    queryFn: () => fetchScans(projectId, page),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      anyScanRunning(query.state.data?.items) ? 5000 : false,
  })
}

export type ScanListItem = Awaited<ReturnType<typeof fetchScans>>["items"][number]

async function fetchScan(scanId: string) {
  return unwrap(await api.api.scans({ scanId }).get())
}

/** One scan's full detail (counters, error, commit). Polls while running. */
export function scanQueryOptions(projectId: string, scanId: string) {
  return queryOptions({
    queryKey: qk.scan(projectId, scanId),
    queryFn: () => fetchScan(scanId),
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 5000 : false,
  })
}

export type ScanDetail = Awaited<ReturnType<typeof fetchScan>>

async function fetchScanDiff(scanId: string) {
  return unwrap(await api.api.scans({ scanId }).diff.get())
}

/** New / resolved findings and new majors since the previous scan. */
export function scanDiffQueryOptions(scanId: string) {
  return queryOptions({
    queryKey: qk.scanDiff(scanId),
    queryFn: () => fetchScanDiff(scanId),
  })
}

export type ScanDiff = Awaited<ReturnType<typeof fetchScanDiff>>
