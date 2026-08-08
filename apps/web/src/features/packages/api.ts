import { keepPreviousData, queryOptions } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"

export type Ecosystem = "npm" | "pypi"

export interface PackagesParams {
  q?: string
  ecosystem?: Ecosystem
  direct?: boolean
  hasVuln?: boolean
  sort?: "name" | "projects" | "severity"
  page: number
  pageSize: number
}

async function fetchPackages(params: PackagesParams) {
  return unwrap(await api.api.packages.get({ query: params }))
}

/** Every package in use across the fleet, filtered/paged server-side. */
export function packagesQueryOptions(params: PackagesParams) {
  return queryOptions({
    queryKey: [...qk.packages(), params] as const,
    queryFn: () => fetchPackages(params),
    placeholderData: keepPreviousData,
  })
}

export type PackageIndexItem = Awaited<
  ReturnType<typeof fetchPackages>
>["items"][number]

async function fetchUsages(name: string, ecosystem?: Ecosystem) {
  return unwrap(
    await api.api
      .packages({ name: encodeURIComponent(name) })
      .usages.get({ query: { ecosystem } })
  )
}

/** Which projects ship a package, and at which versions. */
export function packageUsagesQueryOptions(name: string, ecosystem?: Ecosystem) {
  return queryOptions({
    queryKey: [...qk.packageUsages(name), ecosystem ?? "any"] as const,
    queryFn: () => fetchUsages(name, ecosystem),
    enabled: name !== "",
  })
}

export type PackageUsageItem = Awaited<
  ReturnType<typeof fetchUsages>
>["items"][number]
