import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { ApiError } from "@/lib/api-error"
import { authClient } from "@/lib/auth-client"
import type { Role } from "@/lib/permissions"
import { qk } from "@/lib/query-keys"

interface AuthClientErrorShape {
  status?: number
  statusText?: string
  message?: string
  code?: string
}

interface AuthClientResult<T> {
  data: T | null
  error: AuthClientErrorShape | null
}

/**
 * `authClient.*` calls resolve to `{ data, error }` rather than throwing —
 * this normalizes failures into the same `ApiError` the Eden-backed API uses,
 * so `QueryBoundary`/`ErrorState` and the mutation-cache toast handler work
 * identically regardless of which client produced the error.
 */
function unwrapAuth<T>(result: AuthClientResult<T>): T {
  if (result.error !== null) {
    throw new ApiError(result.error.status ?? 500, {
      message: result.error.message ?? result.error.code ?? "Request failed",
    })
  }
  if (result.data === null) {
    throw new ApiError(500, { message: "Empty response" })
  }
  return result.data
}

async function fetchUsers() {
  return unwrapAuth(
    await authClient.admin.listUsers({
      query: { limit: 100, sortBy: "createdAt" },
    })
  )
}

/** Everyone with access. better-auth's admin plugin has no server-side pagination UI needs here (capped at 100). */
export function usersQueryOptions() {
  return queryOptions({
    queryKey: qk.users(),
    queryFn: fetchUsers,
  })
}

export type UserListItem = Awaited<
  ReturnType<typeof fetchUsers>
>["users"][number]

export interface CreateUserInput {
  name: string
  email: string
  password: string
  role: Role
}

export function useCreateUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreateUserInput) =>
      unwrapAuth(
        await authClient.admin.createUser({
          name: input.name,
          email: input.email,
          password: input.password,
          role: input.role,
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.users() })
    },
  })
}

export function useSetRole() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Role }) =>
      unwrapAuth(await authClient.admin.setRole({ userId, role })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.users() })
    },
  })
}

export function useBanUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      userId,
      banReason,
    }: {
      userId: string
      banReason?: string
    }) => unwrapAuth(await authClient.admin.banUser({ userId, banReason })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.users() })
    },
  })
}

export function useUnbanUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (userId: string) =>
      unwrapAuth(await authClient.admin.unbanUser({ userId })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.users() })
    },
  })
}
