import { MutationCache, QueryClient } from "@tanstack/react-query"
import { toast } from "@workspace/ui/components/toast"
import { ApiError } from "./api-error"

/**
 * Mutations can set `meta.toast` to override the generic error toast (eg.
 * a friendlier message for a specific ApiError status) without having to
 * opt out of the shared MutationCache handler below.
 */
declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      toast?: (
        error: unknown
      ) => { title: string; description?: string } | undefined
    }
  }
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status < 500) return false
          return failureCount < 2
        },
      },
    },
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const override = mutation.meta?.toast?.(error)
        toast.add(
          override ?? {
            title: "Something went wrong",
            description:
              error instanceof ApiError ? error.detail : "Unexpected error",
          }
        )
      },
    }),
  })
}
