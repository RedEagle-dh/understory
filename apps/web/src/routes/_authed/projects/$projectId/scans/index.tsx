import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight, ScanSearch } from "lucide-react"
import { z } from "zod"
import { Button } from "@workspace/ui/components/button"
import { ScanNowButton } from "@/components/common/scan-now-button"
import { DataTable } from "@/components/data-table/data-table"
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { scansQueryOptions } from "@/features/scans/api"
import { scanColumns } from "@/features/scans/columns"

const searchSchema = z.object({
  page: z.number().int().min(1).catch(1).default(1),
})

export const Route = createFileRoute("/_authed/projects/$projectId/scans/")({
  staticData: { crumb: "Scans" },
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Scans · understory" }] }),
  component: ProjectScans,
})

function ProjectScans() {
  const { projectId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const query = useQuery(scansQueryOptions(projectId, search.page))

  return (
    <>
      <PageHeader
        title="Scans"
        description="Scan history for this project, newest first."
      />

      <QueryBoundary query={query} skeleton={<DataTableSkeleton columns={8} />}>
        {(data) => {
          if (data.total === 0) {
            return (
              <EmptyState
                icon={ScanSearch}
                title="No scans yet"
                description="This project hasn't been scanned. The first scan will run within the hour."
                action={<ScanNowButton projectId={projectId} />}
              />
            )
          }

          const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize))

          return (
            <div className="flex flex-col gap-3">
              <DataTable
                columns={scanColumns}
                data={data.items}
                rowCount={data.total}
                getRowId={(row) => row.id}
                onRowClick={(row) =>
                  navigate({
                    to: "/projects/$projectId/scans/$scanId",
                    params: { projectId, scanId: row.id },
                  })
                }
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-heading text-xs text-muted-foreground">
                  {data.total} scan{data.total === 1 ? "" : "s"}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={search.page <= 1}
                    onClick={() =>
                      navigate({
                        search: (prev) => ({ ...prev, page: prev.page - 1 }),
                        replace: true,
                      })
                    }
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
                    onClick={() =>
                      navigate({
                        search: (prev) => ({ ...prev, page: prev.page + 1 }),
                        replace: true,
                      })
                    }
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </div>
          )
        }}
      </QueryBoundary>
    </>
  )
}
