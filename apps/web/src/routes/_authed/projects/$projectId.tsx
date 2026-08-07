import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, Outlet } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { ExternalLink } from "lucide-react"
import { RoleGate } from "@/components/common/role-gate"
import { ScanNowButton } from "@/components/common/scan-now-button"
import { ScanStatusPill } from "@/components/common/scan-status-pill"
import { QueryBoundary } from "@/components/states/query-boundary"
import {
  projectQueryOptions,
  useInvalidateProjectOnScanComplete,
} from "@/features/projects/api"
import { hasRunningScan } from "@/features/projects/lib"
import { CreatePrSheet } from "@/features/pull-requests/components/create-pr-sheet"
import { CreatePrFlowProvider } from "@/features/pull-requests/create-pr-context"

export const Route = createFileRoute("/_authed/projects/$projectId")({
  component: ProjectLayout,
})

const tabLinkClass =
  "-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-1 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[status=active]:border-foreground data-[status=active]:text-foreground"

function ProjectHeader() {
  const { projectId } = Route.useParams()
  const query = useQuery(projectQueryOptions(projectId))
  useInvalidateProjectOnScanComplete(projectId, query.data?.lastScan?.status)

  return (
    <QueryBoundary
      query={query}
      skeleton={<div className="mb-6 h-14 animate-pulse rounded-lg bg-muted" />}
    >
      {(project) => (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-heading font-semibold text-xl tracking-tight">
                {project.name}
              </h1>
              {project.paused && <Badge variant="outline">paused</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <a
                href={`https://github.com/${project.owner}/${project.repo}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-heading hover:text-foreground hover:underline"
              >
                {project.owner}/{project.repo}
                <ExternalLink className="size-3" />
              </a>
              {project.branch !== "" && (
                <Badge variant="outline" className="font-heading">
                  {project.branch}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <ScanStatusPill scan={project.lastScan} />
            <ScanNowButton
              projectId={project.id}
              running={hasRunningScan(project.lastScan)}
              variant="outline"
            />
          </div>
        </div>
      )}
    </QueryBoundary>
  )
}

function ProjectLayout() {
  const { projectId } = Route.useParams()

  return (
    <CreatePrFlowProvider>
      <div>
        <ProjectHeader />

        <nav className="mb-6 flex gap-6 border-b">
          <Link
            to="/projects/$projectId"
            params={{ projectId }}
            // includeSearch: false — the dependencies table keeps its
            // pagination in search params, and exact matching would compare
            // those too, leaving the tab unhighlighted.
            activeOptions={{ exact: true, includeSearch: false }}
            className={tabLinkClass}
          >
            Dependencies
          </Link>
          <Link
            to="/projects/$projectId/vulnerabilities"
            params={{ projectId }}
            className={tabLinkClass}
          >
            Vulnerabilities
          </Link>
          <Link
            to="/projects/$projectId/scans"
            params={{ projectId }}
            className={tabLinkClass}
          >
            Scans
          </Link>
          <Link
            to="/projects/$projectId/pull-requests"
            params={{ projectId }}
            className={tabLinkClass}
          >
            Pull requests
          </Link>
          <RoleGate capability="editProject">
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId }}
              className={tabLinkClass}
            >
              Settings
            </Link>
          </RoleGate>
        </nav>

        <Outlet />
      </div>

      <CreatePrSheet projectId={projectId} />
    </CreatePrFlowProvider>
  )
}
