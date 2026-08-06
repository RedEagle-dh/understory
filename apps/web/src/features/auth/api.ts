import { queryOptions } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { authClient, type Session } from "@/lib/auth-client"
import { qk } from "@/lib/query-keys"

/**
 * Session as a query (NOT authClient.useSession) so route guards
 * (`beforeLoad` → ensureQueryData) and components read the same cache entry,
 * and sign-out is a single setQueryData(null).
 */
export function sessionQueryOptions() {
  return queryOptions<Session | null>({
    queryKey: qk.session(),
    queryFn: async () => {
      const { data } = await authClient.getSession()
      return data ?? null
    },
    staleTime: 60_000,
  })
}

export function setupStatusQueryOptions() {
  return queryOptions({
    queryKey: qk.setupStatus(),
    queryFn: async () => unwrap(await api.api.bootstrap.get()),
    staleTime: 0,
  })
}
