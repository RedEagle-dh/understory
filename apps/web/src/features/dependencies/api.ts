import { keepPreviousData, queryOptions } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"

export type DepType = "prod" | "dev" | "peer" | "optional" | "peer_optional"
export type UpdateKind = "none" | "patch" | "minor" | "major"

export interface DependenciesParams {
  q?: string
  /** Several types combine as OR; empty/undefined = all types. */
  depType?: DepType[]
  direct?: boolean
  /** Several kinds combine as OR; empty/undefined = all kinds. */
  updateKind?: UpdateKind[]
  hasVuln?: boolean
  sort?: "name" | "severity" | "updateKind"
  page: number
  pageSize: number
}

/** Dependency tree of the project's last successful scan, filtered/paged server-side. */
export function dependenciesQueryOptions(
  projectId: string,
  params: DependenciesParams
) {
  return queryOptions({
    queryKey: [...qk.dependencies(projectId), params] as const,
    queryFn: async () =>
      unwrap(
        await api.api.projects({ projectId }).dependencies.get({
          query: {
            ...params,
            // The API takes multi-value filters as comma-separated lists.
            depType:
              params.depType === undefined || params.depType.length === 0
                ? undefined
                : params.depType.join(","),
            updateKind:
              params.updateKind === undefined || params.updateKind.length === 0
                ? undefined
                : params.updateKind.join(","),
          },
        })
      ),
    placeholderData: keepPreviousData,
  })
}

/** One package's versions-in-tree, per-workspace status, and open findings. */
export function dependencyDetailQueryOptions(projectId: string, name: string) {
  return queryOptions({
    queryKey: [...qk.dependencies(projectId), "detail", name] as const,
    queryFn: async () =>
      unwrap(
        await api.api
          .projects({ projectId })
          .dependencies({ name: encodeURIComponent(name) })
          .get()
      ),
    enabled: name !== "",
  })
}
