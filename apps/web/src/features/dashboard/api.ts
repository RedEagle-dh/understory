import { queryOptions } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"

async function fetchDashboard() {
  return unwrap(await api.api.dashboard.get())
}

export type DashboardSummary = Awaited<ReturnType<typeof fetchDashboard>>
export type TrendPoint = DashboardSummary["trend"][number]

export function dashboardQueryOptions() {
  return queryOptions({
    queryKey: qk.dashboard(),
    queryFn: fetchDashboard,
    staleTime: 60_000,
  })
}
