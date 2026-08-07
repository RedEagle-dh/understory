import { useQuery } from "@tanstack/react-query"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { PageColumn } from "@/components/states/page-column"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { RuleList } from "@/features/notifications/components/rule-list"
import { projectQueryOptions } from "@/features/projects/api"
import { AccessTokenCard } from "@/features/projects/components/settings/access-token-card"
import { AutoBumpCard } from "@/features/projects/components/settings/auto-bump-card"
import { AutoPrCard } from "@/features/projects/components/settings/auto-pr-card"
import { DangerZoneCard } from "@/features/projects/components/settings/danger-zone-card"
import { RepositoryCard } from "@/features/projects/components/settings/repository-card"
import { ScanningCard } from "@/features/projects/components/settings/scanning-card"

export const Route = createFileRoute("/_authed/projects/$projectId/settings")({
  staticData: { crumb: "Settings" },
  beforeLoad: ({ context }) => {
    if (!context.can.has("editProject")) throw redirect({ to: "/" })
  },
  head: () => ({
    meta: [{ title: "Project settings · understory" }],
  }),
  component: ProjectSettings,
})

function ProjectSettings() {
  const { projectId } = Route.useParams()
  const query = useQuery(projectQueryOptions(projectId))

  return (
    <PageColumn>
      <PageHeader
        title="Project settings"
        description="Repository connection, scan schedule, and danger zone for this project."
      />
      <QueryBoundary query={query}>
        {(project) => (
          <div className="flex flex-col gap-6">
            <RepositoryCard project={project} />
            <AccessTokenCard project={project} />
            <ScanningCard project={project} />
            <AutoPrCard project={project} />
            <AutoBumpCard project={project} />
            <RuleList projectId={project.id} />
            <DangerZoneCard project={project} />
          </div>
        )}
      </QueryBoundary>
    </PageColumn>
  )
}
