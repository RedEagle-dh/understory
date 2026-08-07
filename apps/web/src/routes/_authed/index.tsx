import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { FolderKanban } from "lucide-react"
import { RoleGate } from "@/components/common/role-gate"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { dashboardQueryOptions } from "@/features/dashboard/api"
import { FleetStats } from "@/features/dashboard/components/fleet-stats"
import { RecentScans } from "@/features/dashboard/components/recent-scans"
import { VulnTrendChart } from "@/features/dashboard/components/vuln-trend-chart"
import { WorstProjects } from "@/features/dashboard/components/worst-projects"
import { AddProjectButton } from "@/features/projects/components/add-project-button"

export const Route = createFileRoute("/_authed/")({
  staticData: { crumb: "Dashboard" },
  head: () => ({ meta: [{ title: "Dashboard · understory" }] }),
  component: Dashboard,
})

function Dashboard() {
  const query = useQuery({
    ...dashboardQueryOptions(),
    // Poll while anything is in flight so the feed and tiles converge on
    // their own — same cadence the projects list uses.
    refetchInterval: (q) =>
      (q.state.data?.schedulerHealth.runningScans ?? 0) > 0 ? 5000 : false,
  })

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Fleet-wide health: open findings, activity, and the 30-day trend."
      />
      <QueryBoundary
        query={query}
        empty={(data) => data.totals.projects === 0}
        emptyState={
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            description="Register a GitHub repo to start scanning it for vulnerable and outdated dependencies."
            action={
              <RoleGate capability="createProject">
                <AddProjectButton />
              </RoleGate>
            }
          />
        }
      >
        {(data) => (
          <div className="flex flex-col gap-6">
            <FleetStats totals={data.totals} />
            <VulnTrendChart trend={data.trend} />
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <WorstProjects projects={data.worstProjects} />
              <RecentScans scans={data.recentScans} />
            </div>
          </div>
        )}
      </QueryBoundary>
    </>
  )
}
