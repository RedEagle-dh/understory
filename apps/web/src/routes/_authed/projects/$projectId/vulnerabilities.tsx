import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { ChevronLeft, ChevronRight, SearchX, ShieldCheck } from "lucide-react"
import { useEffect, useState } from "react"
import { z } from "zod"
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { projectQueryOptions } from "@/features/projects/api"
import {
  summaryQueryOptions,
  vulnsQueryOptions,
} from "@/features/vulnerabilities/api"
import { AdvisoryList } from "@/features/vulnerabilities/components/advisory-list"
import { FindingDetailSheet } from "@/features/vulnerabilities/components/finding-detail-sheet"
import { SeveritySummaryStrip } from "@/features/vulnerabilities/components/severity-summary-strip"
import { VulnerabilitiesToolbar } from "@/features/vulnerabilities/components/vulnerabilities-toolbar"
import { formatRelative } from "@/lib/format"

const PAGE_SIZE = 20

const searchSchema = z.object({
  severity: z.enum(["low", "moderate", "high", "critical"]).optional(),
  state: z.enum(["open", "resolved", "ignored"]).catch("open").default("open"),
  fixable: z.boolean().optional(),
  direct: z.boolean().optional(),
  q: z.string().optional(),
  page: z.number().int().min(1).catch(1).default(1),
})

export const Route = createFileRoute(
  "/_authed/projects/$projectId/vulnerabilities"
)({
  staticData: { crumb: "Vulnerabilities" },
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Vulnerabilities · understory" }] }),
  component: ProjectVulnerabilities,
})

function ProjectVulnerabilities() {
  const { projectId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null
  )

  // The detail sheet is local UI state, not a search param — close it
  // whenever the project itself changes out from under it.
  useEffect(() => {
    setSelectedFindingId(null)
  }, [projectId])

  const summaryQuery = useQuery(summaryQueryOptions(projectId))
  const projectQuery = useQuery(projectQueryOptions(projectId))

  const query = useQuery(
    vulnsQueryOptions(projectId, {
      severity: search.severity,
      state: search.state,
      direct: search.direct,
      hasFix: search.fixable,
      q: search.q,
      page: search.page,
      pageSize: PAGE_SIZE,
    })
  )

  const hasActiveFilters =
    search.severity !== undefined ||
    search.state !== "open" ||
    search.fixable === true ||
    search.direct === true ||
    (search.q ?? "") !== ""

  const updateSearch = (patch: {
    q?: string
    severity?: (typeof search)["severity"]
    state?: (typeof search)["state"]
    fixable?: boolean
    direct?: boolean
  }) =>
    navigate({
      search: (prev) => ({ ...prev, ...patch, page: 1 }),
      replace: true,
    })

  const resetFilters = () =>
    navigate({
      search: (prev) => ({
        ...prev,
        severity: undefined,
        state: "open",
        fixable: undefined,
        direct: undefined,
        q: undefined,
        page: 1,
      }),
      replace: true,
    })

  const setPage = (page: number) =>
    navigate({ search: (prev) => ({ ...prev, page }), replace: true })

  const lastScan = projectQuery.data?.lastScan ?? null
  const emptyDescription =
    lastScan !== null && lastScan.finishedAt !== null
      ? `Last scanned ${formatRelative(lastScan.finishedAt)}.`
      : "Vulnerability findings will show up here after the next scan."

  return (
    <>
      <PageHeader
        title="Vulnerabilities"
        description="Known registry and OSV advisories affecting this project's dependency tree, grouped by advisory."
      />

      {summaryQuery.data !== undefined && (
        <div className="mb-4">
          <SeveritySummaryStrip
            counts={summaryQuery.data.open}
            active={search.severity}
            onChange={(severity) => updateSearch({ severity })}
          />
        </div>
      )}

      <QueryBoundary query={query} skeleton={<DataTableSkeleton columns={5} />}>
        {(data) => {
          if (data.total === 0 && !hasActiveFilters) {
            return (
              <EmptyState
                icon={ShieldCheck}
                title="No open vulnerabilities"
                description={emptyDescription}
              />
            )
          }

          const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

          return (
            <div className="flex flex-col gap-3">
              <VulnerabilitiesToolbar
                q={search.q ?? ""}
                state={search.state}
                fixable={search.fixable}
                direct={search.direct}
                onChange={updateSearch}
                onReset={resetFilters}
              />

              {data.total === 0 ? (
                <EmptyState
                  icon={SearchX}
                  title="No vulnerabilities match these filters"
                  description="Try loosening or resetting the filters above."
                  action={
                    <Button variant="outline" onClick={resetFilters}>
                      Reset filters
                    </Button>
                  }
                />
              ) : (
                <>
                  <AdvisoryList
                    projectId={projectId}
                    items={data.items}
                    state={search.state}
                    onSelectFinding={setSelectedFindingId}
                  />

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-heading text-muted-foreground text-xs">
                      {data.total} finding{data.total === 1 ? "" : "s"}
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
                      <span className="w-16 text-center font-heading text-muted-foreground text-xs">
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

      <FindingDetailSheet
        findingId={selectedFindingId}
        onOpenChange={(open) => {
          if (!open) setSelectedFindingId(null)
        }}
      />
    </>
  )
}
