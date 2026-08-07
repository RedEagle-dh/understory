import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import type { RowSelectionState } from "@tanstack/react-table"
import { Button } from "@workspace/ui/components/button"
import { Package, SearchX } from "lucide-react"
import { useEffect, useState } from "react"
import { z } from "zod"
import { BulkActionBar } from "@/components/common/bulk-action-bar"
import { ScanNowButton } from "@/components/common/scan-now-button"
import { DataTable } from "@/components/data-table/data-table"
import { DataTablePagination } from "@/components/data-table/data-table-pagination"
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { dependenciesQueryOptions } from "@/features/dependencies/api"
import { dependencyColumns } from "@/features/dependencies/columns"
import { DependenciesToolbar } from "@/features/dependencies/components/dependencies-toolbar"
import { DependencyDetailSheet } from "@/features/dependencies/components/dependency-detail-sheet"
import { useCreatePrFlow } from "@/features/pull-requests/create-pr-context"
import { useTableSearchParams } from "@/hooks/use-table-search-params"

/**
 * `type` and `direct` have DEFAULTS (direct prod+dev deps), so "absent" and
 * "explicitly cleared" must be distinguishable: an absent param applies the
 * default, `type: []` / `direct: false` mean "show everything".
 */
const DEFAULT_TYPES = ["prod", "dev"] as const

const searchSchema = z.object({
  q: z.string().optional(),
  type: z
    .array(z.enum(["prod", "dev", "peer", "optional", "peer_optional"]))
    .optional()
    .catch(undefined),
  direct: z.boolean().optional(),
  updateKind: z
    .array(z.enum(["none", "patch", "minor", "major"]))
    .optional()
    .catch(undefined),
  hasVuln: z.boolean().optional(),
  sort: z.enum(["name", "severity", "updateKind"]).optional(),
  page: z.number().int().min(1).catch(1).default(1),
  pageSize: z.number().int().min(1).max(200).catch(50).default(50),
})

export const Route = createFileRoute("/_authed/projects/$projectId/")({
  staticData: { crumb: "Dependencies" },
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Dependencies · understory" }] }),
  component: ProjectDependencies,
})

/**
 * Row identity must include version AND dep type: the same package regularly
 * appears at several versions in one tree (`@babel/parser` twice in npm/cli),
 * and workspace+name alone produced duplicate React keys + selection
 * collisions. Mirrors the DB's uniqueness on (workspace, name, version, type).
 */
function depRowId(row: {
  workspace: string
  name: string
  version: string
  depType: string
}): string {
  return `${row.workspace}:${row.name}@${row.version}:${row.depType}`
}

function ProjectDependencies() {
  const { projectId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const createPrFlow = useCreatePrFlow()

  // The detail sheet and row selection are local UI state, not search
  // params — clear them whenever the project itself changes out from under.
  useEffect(() => {
    setSelectedName(null)
    setRowSelection({})
  }, [projectId])

  const {
    pagination,
    onPaginationChange,
    sorting,
    onSortingChange,
    updateSearch,
    setPage,
    setPageSize,
  } = useTableSearchParams({ search, navigate })

  // Defaults: the everyday view is the DIRECT prod+dev dependencies. An
  // explicit `type: []` / `direct: false` in the URL means "show everything".
  const typeFilter = search.type ?? [...DEFAULT_TYPES]
  const directOnly = search.direct ?? true

  const query = useQuery(
    dependenciesQueryOptions(projectId, {
      q: search.q,
      depType: typeFilter,
      direct: directOnly ? true : undefined,
      updateKind: search.updateKind,
      hasVuln: search.hasVuln,
      sort: search.sort,
      page: search.page,
      pageSize: search.pageSize,
    })
  )

  // "Active" = deviating from the default view, so the empty-project state
  // still reads "no data yet" rather than "no match" on a fresh project.
  const typeIsDefault =
    typeFilter.length === DEFAULT_TYPES.length &&
    DEFAULT_TYPES.every((value) => typeFilter.includes(value))
  const hasActiveFilters =
    (search.q ?? "") !== "" ||
    !typeIsDefault ||
    (search.updateKind !== undefined && search.updateKind.length > 0) ||
    directOnly !== true ||
    search.hasVuln !== undefined

  const resetFilters = () =>
    navigate({
      search: (prev) => ({
        ...prev,
        q: undefined,
        type: undefined,
        updateKind: undefined,
        direct: undefined,
        hasVuln: undefined,
        page: 1,
      }),
      replace: true,
    })

  return (
    <>
      <PageHeader
        title="Dependencies"
        description="Every package this project depends on, with its current and latest available version."
      />

      <QueryBoundary query={query} skeleton={<DataTableSkeleton columns={6} />}>
        {(data) => {
          if (data.total === 0 && !hasActiveFilters) {
            return (
              <EmptyState
                icon={Package}
                title="No dependency data yet"
                description="Dependencies will appear here once the first scan of this project completes."
                action={<ScanNowButton projectId={projectId} />}
              />
            )
          }

          return (
            <div className="flex flex-col gap-3">
              <DependenciesToolbar
                q={search.q ?? ""}
                depType={typeFilter}
                updateKind={search.updateKind ?? []}
                direct={directOnly}
                hasVuln={search.hasVuln}
                activeFilterCount={
                  [
                    (search.q ?? "") !== "",
                    !typeIsDefault,
                    (search.updateKind?.length ?? 0) > 0,
                    directOnly !== true,
                    search.hasVuln === true,
                  ].filter(Boolean).length
                }
                onChange={updateSearch}
                onReset={resetFilters}
              />

              {data.total === 0 ? (
                <EmptyState
                  icon={SearchX}
                  title="No dependencies match these filters"
                  description="Try loosening or resetting the filters above."
                  action={
                    <Button variant="outline" onClick={resetFilters}>
                      Reset filters
                    </Button>
                  }
                />
              ) : (
                <>
                  <DataTable
                    columns={dependencyColumns}
                    data={data.items}
                    rowCount={data.total}
                    manualSorting
                    manualPagination
                    manualFiltering
                    sorting={sorting}
                    onSortingChange={onSortingChange}
                    pagination={pagination}
                    onPaginationChange={onPaginationChange}
                    rowSelection={rowSelection}
                    onRowSelectionChange={setRowSelection}
                    getRowId={depRowId}
                    onRowClick={(row) => setSelectedName(row.name)}
                  />
                  <DataTablePagination
                    page={search.page}
                    pageSize={search.pageSize}
                    total={data.total}
                    onPageChange={setPage}
                    onPageSizeChange={setPageSize}
                  />

                  <BulkActionBar
                    count={
                      data.items.filter((row) => rowSelection[depRowId(row)])
                        .length
                    }
                    onCreatePr={() => {
                      const selected = data.items.filter(
                        (row) => rowSelection[depRowId(row)]
                      )
                      createPrFlow.openWith(
                        selected.map((row) => ({
                          name: row.name,
                          workspace: row.workspace,
                          toVersion:
                            row.updateKind !== "none" ||
                            row.maxSeverity !== null
                              ? (row.latestVersion ?? undefined)
                              : undefined,
                          hint: "latest" as const,
                        }))
                      )
                      setRowSelection({})
                    }}
                    onClear={() => setRowSelection({})}
                  />
                </>
              )}
            </div>
          )
        }}
      </QueryBoundary>

      <DependencyDetailSheet
        projectId={projectId}
        name={selectedName}
        onOpenChange={(open) => {
          if (!open) setSelectedName(null)
        }}
      />
    </>
  )
}
