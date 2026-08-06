import type { UseQueryResult } from "@tanstack/react-query"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { ErrorState } from "./error-state"

interface QueryBoundaryProps<T> {
  query: UseQueryResult<T>
  /** Data is present but semantically empty (eg. an empty array) — show `emptyState` instead of `children`. */
  empty?: (data: T) => boolean
  emptyState?: React.ReactNode
  /** Defaults to a few skeleton lines. */
  skeleton?: React.ReactNode
  children: (data: T) => React.ReactNode
}

const defaultSkeleton = (
  <div className="space-y-3">
    <Skeleton className="h-4 w-1/3" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-2/3" />
  </div>
)

/**
 * The core shared data-fetching boundary: pending → skeleton, error →
 * ErrorState with retry, empty → emptyState, else render children(data).
 * Every list/detail view in the app should route through this instead of
 * hand-rolling isPending/isError checks.
 */
export function QueryBoundary<T>({
  query,
  empty,
  emptyState,
  skeleton,
  children,
}: QueryBoundaryProps<T>) {
  if (query.isPending) {
    return <>{skeleton ?? defaultSkeleton}</>
  }

  if (query.isError) {
    return (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    )
  }

  if (emptyState !== undefined && (empty?.(query.data) ?? false)) {
    return <>{emptyState}</>
  }

  return <>{children(query.data)}</>
}
