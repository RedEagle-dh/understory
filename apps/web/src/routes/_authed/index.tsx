import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { FolderKanban } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { RoleGate } from "@/components/common/role-gate"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { dashboardQueryOptions } from "@/features/dashboard/api"
import { FleetStats } from "@/features/dashboard/components/fleet-stats"
import { ProjectGrid } from "@/features/dashboard/components/project-grid"
import { VulnTrendChart } from "@/features/dashboard/components/vuln-trend-chart"
import {
  projectsQueryOptions,
  useInvalidateFleetOnScanComplete,
} from "@/features/projects/api"

export const Route = createFileRoute("/_authed/")({
  staticData: { crumb: "Dashboard" },
  head: () => ({ meta: [{ title: "Dashboard · understory" }] }),
  component: Dashboard,
})

function TrendSection() {
  const query = useQuery(dashboardQueryOptions())
  // The trend is supplementary — render nothing on error rather than a
  // second error surface next to the projects grid.
  if (query.data === undefined) return null
  return <VulnTrendChart trend={query.data.trend} />
}

function Dashboard() {
  const query = useQuery(projectsQueryOptions())
  useInvalidateFleetOnScanComplete(query.data?.projects)

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="An overview of your registered projects and their latest scans."
      />
      <QueryBoundary
        query={query}
        empty={(data) => data.projects.length === 0}
        emptyState={
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            description="Register a GitHub repo to start scanning it for vulnerable and outdated dependencies."
            action={
              <RoleGate capability="createProject">
                <Button render={<Link to="/projects/new" />}>
                  Add project
                </Button>
              </RoleGate>
            }
          />
        }
      >
        {(data) => (
          <div className="flex flex-col gap-6">
            <FleetStats projects={data.projects} />
            <TrendSection />
            <ProjectGrid projects={data.projects} />
          </div>
        )}
      </QueryBoundary>
    </>
  )
}
