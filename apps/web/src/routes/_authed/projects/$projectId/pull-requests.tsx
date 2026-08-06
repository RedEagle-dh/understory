import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight, GitPullRequest } from "lucide-react"
import { z } from "zod"
import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { DataTable } from "@/components/data-table/data-table"
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { buildPrColumns } from "@/features/pull-requests/columns"
import { type PrState, prsQueryOptions } from "@/features/pull-requests/api"

const PAGE_SIZE = 20

const STATE_OPTIONS: { label: string; value: PrState | "all" }[] = [
  { label: "All states", value: "all" },
  { label: "Creating", value: "creating" },
  { label: "Open", value: "open" },
  { label: "Merged", value: "merged" },
  { label: "Closed", value: "closed" },
  { label: "Failed", value: "failed" },
]

const searchSchema = z.object({
  state: z.enum(["creating", "open", "merged", "closed", "failed"]).optional(),
  page: z.number().int().min(1).catch(1).default(1),
})

export const Route = createFileRoute(
  "/_authed/projects/$projectId/pull-requests"
)({
  staticData: { crumb: "Pull requests" },
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Pull requests · understory" }] }),
  component: ProjectPullRequests,
})

function ProjectPullRequests() {
  const { projectId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const columns = useMemo(() => buildPrColumns(projectId), [projectId])

  const query = useQuery(
    prsQueryOptions(projectId, {
      state: search.state,
      page: search.page,
      pageSize: PAGE_SIZE,
    })
  )

  const setPage = (page: number) =>
    navigate({ search: (prev) => ({ ...prev, page }), replace: true })

  const setState = (state: PrState | undefined) =>
    navigate({
      search: (prev) => ({ ...prev, state, page: 1 }),
      replace: true,
    })

  return (
    <>
      <PageHeader
        title="Pull requests"
        description="Version-bump pull requests opened for this project, manually or automatically for security advisories."
      />

      <QueryBoundary query={query} skeleton={<DataTableSkeleton columns={6} />}>
        {(data) => {
          if (data.total === 0 && search.state === undefined) {
            return (
              <EmptyState
                icon={GitPullRequest}
                title="No pull requests yet"
                description="Open one from the Dependencies or Vulnerabilities tab."
              />
            )
          }

          const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

          return (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Select
                  value={search.state ?? "all"}
                  onValueChange={(value) => {
                    if (value === null) return
                    setState(value === "all" ? undefined : (value as PrState))
                  }}
                >
                  <SelectTrigger size="sm" className="h-8 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {data.total === 0 ? (
                <EmptyState
                  icon={GitPullRequest}
                  title="No pull requests match this filter"
                  description="Try a different state, or reset the filter."
                  action={
                    <Button
                      variant="outline"
                      onClick={() => setState(undefined)}
                    >
                      Reset filter
                    </Button>
                  }
                />
              ) : (
                <>
                  <DataTable columns={columns} data={data.items} />

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-heading text-xs text-muted-foreground">
                      {data.total} pull request{data.total === 1 ? "" : "s"}
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        disabled={search.page <= 1}
                        onClick={() => setPage(search.page - 1)}
                      >
                        <ChevronLeft />
                      </Button>
                      <span className="w-16 text-center font-heading text-xs text-muted-foreground">
                        {search.page} / {pageCount}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        disabled={search.page >= pageCount}
                        onClick={() => setPage(search.page + 1)}
                      >
                        <ChevronRight />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )
        }}
      </QueryBoundary>
    </>
  )
}
