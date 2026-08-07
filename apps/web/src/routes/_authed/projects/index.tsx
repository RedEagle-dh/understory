import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { FolderKanban } from "lucide-react"
import { RoleGate } from "@/components/common/role-gate"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { ProjectGrid } from "@/features/dashboard/components/project-grid"
import {
  projectsQueryOptions,
  useInvalidateFleetOnScanComplete,
} from "@/features/projects/api"

export const Route = createFileRoute("/_authed/projects/")({
  staticData: { crumb: "Projects" },
  head: () => ({ meta: [{ title: "Projects · understory" }] }),
  component: ProjectsPage,
})

function ProjectsPage() {
  const query = useQuery(projectsQueryOptions())
  useInvalidateFleetOnScanComplete(query.data?.projects)

  return (
    <>
      <PageHeader
        title="Projects"
        description="Every registered project and its latest scan."
        actions={
          <RoleGate capability="createProject">
            <Button render={<Link to="/projects/new" />}>Add project</Button>
          </RoleGate>
        }
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
        {(data) => <ProjectGrid projects={data.projects} />}
      </QueryBoundary>
    </>
  )
}
