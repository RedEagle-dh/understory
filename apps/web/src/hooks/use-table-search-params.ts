import type {
  OnChangeFn,
  PaginationState,
  SortingState,
} from "@tanstack/react-table"

interface TableSearchBase {
  page: number
  pageSize: number
  sort?: string
}

type NavigateFn<TSearch> = (opts: {
  search: (prev: TSearch) => TSearch
  replace: boolean
}) => unknown

interface UseTableSearchParamsArgs<TSearch extends TableSearchBase> {
  search: TSearch
  navigate: NavigateFn<TSearch>
}

/**
 * Binds a manual (server-driven) TanStack Table's pagination/sorting state
 * to a route's search params via `navigate({ search, replace: true })` —
 * paging, sorting, and filtering never grow the history stack. Changing a
 * filter or the sort resets to page 1; changing the page alone does not.
 */
export function useTableSearchParams<TSearch extends TableSearchBase>({
  search,
  navigate,
}: UseTableSearchParamsArgs<TSearch>) {
  const pagination: PaginationState = {
    pageIndex: search.page - 1,
    pageSize: search.pageSize,
  }

  const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
    navigate({
      search: (prev) => {
        const next =
          typeof updater === "function"
            ? updater({ pageIndex: prev.page - 1, pageSize: prev.pageSize })
            : updater
        return { ...prev, page: next.pageIndex + 1, pageSize: next.pageSize }
      },
      replace: true,
    })
  }

  const sorting: SortingState = search.sort
    ? [{ id: search.sort, desc: false }]
    : []

  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    navigate({
      search: (prev) => {
        const prevSorting: SortingState = prev.sort
          ? [{ id: prev.sort, desc: false }]
          : []
        const next =
          typeof updater === "function" ? updater(prevSorting) : updater
        return { ...prev, sort: next[0]?.id, page: 1 } as TSearch
      },
      replace: true,
    })
  }

  /** Patch one or more filter fields; always resets to page 1. */
  const updateSearch = (patch: Partial<TSearch>) => {
    navigate({
      search: (prev) => ({ ...prev, ...patch, page: 1 }),
      replace: true,
    })
  }

  const setPage = (page: number) => {
    navigate({ search: (prev) => ({ ...prev, page }), replace: true })
  }

  const setPageSize = (pageSize: number) => {
    navigate({
      search: (prev) => ({ ...prev, pageSize, page: 1 }),
      replace: true,
    })
  }

  return {
    pagination,
    onPaginationChange,
    sorting,
    onSortingChange,
    updateSearch,
    setPage,
    setPageSize,
  }
}
