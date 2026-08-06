import { useQuery } from "@tanstack/react-query"
import { buildPermissions, type Permissions } from "@/lib/permissions"
import { sessionQueryOptions } from "./api"

export function useSession() {
  return useQuery(sessionQueryOptions())
}

/** Under _authed the session is guaranteed by the route guard. */
export function usePermissions(): Permissions {
  const { data } = useSession()
  return buildPermissions(data?.user.role)
}
