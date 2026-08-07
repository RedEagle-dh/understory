import { queryOptions } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"

async function fetchVersion() {
  return unwrap(await api.api.system.version.get())
}

export type VersionStatus = Awaited<ReturnType<typeof fetchVersion>>

export function versionQueryOptions() {
  return queryOptions<VersionStatus>({
    queryKey: qk.version(),
    queryFn: fetchVersion,
    staleTime: 5 * 60_000,
    // The server's first response after boot has checkedAt null while its
    // lazy check runs; poll briefly until it has an answer, then stop.
    refetchInterval: (query) =>
      query.state.data !== undefined && query.state.data.checkedAt === null
        ? 15_000
        : false,
  })
}
