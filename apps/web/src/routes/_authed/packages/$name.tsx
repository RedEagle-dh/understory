import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"
import { PackageX } from "lucide-react"
import { z } from "zod"
import { CopyButton } from "@/components/common/copy-button"
import { DepTypeBadge } from "@/components/common/dep-type-badge"
import { SeverityBadge } from "@/components/common/severity-badge"
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import {
  packageUsagesQueryOptions,
  type PackageUsageItem,
} from "@/features/packages/api"

const searchSchema = z.object({
  ecosystem: z.enum(["npm", "pypi"]).optional(),
})

export const Route = createFileRoute("/_authed/packages/$name")({
  staticData: { crumb: "Package" },
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Package · understory" }] }),
  component: PackageDetail,
})

const UPDATE_CLASS = {
  major: "text-severity-high",
  minor: "text-severity-moderate",
  patch: "text-muted-foreground",
  none: "text-muted-foreground",
} as const

function PackageDetail() {
  const { name } = Route.useParams()
  const { ecosystem } = Route.useSearch()
  const query = useQuery(packageUsagesQueryOptions(name, ecosystem))

  return (
    <>
      <PageHeader
        title={name}
        description="Every repository that ships this package, and the version each one resolves."
        actions={<CopyButton value={name} label="Copy package name" />}
      />

      <QueryBoundary query={query} skeleton={<DataTableSkeleton columns={5} />}>
        {(data) => {
          if (data.items.length === 0) {
            return (
              <EmptyState
                icon={PackageX}
                title="Not in use"
                description="No tracked repository currently depends on this package."
              />
            )
          }

          // Group by version: during an incident the first question is which
          // versions are in the fleet, and only then which repos hold them.
          const byVersion = new Map<string, PackageUsageItem[]>()
          for (const item of data.items) {
            const bucket = byVersion.get(item.version)
            if (bucket === undefined) byVersion.set(item.version, [item])
            else bucket.push(item)
          }
          const versions = [...byVersion.entries()].sort((a, b) =>
            a[0].localeCompare(b[0], undefined, { numeric: true })
          )

          return (
            <div className="flex flex-col gap-4">
              <p className="font-heading text-muted-foreground text-xs">
                {data.items.length} usage
                {data.items.length === 1 ? "" : "s"} across{" "}
                {new Set(data.items.map((item) => item.projectId)).size} project
                {new Set(data.items.map((item) => item.projectId)).size === 1
                  ? ""
                  : "s"}
                {data.truncated && " (truncated)"}
              </p>

              {versions.map(([version, usages]) => (
                <VersionGroup
                  key={version}
                  name={name}
                  version={version}
                  usages={usages}
                />
              ))}
            </div>
          )
        }}
      </QueryBoundary>
    </>
  )
}

function VersionGroup({
  name,
  version,
  usages,
}: {
  name: string
  version: string
  usages: PackageUsageItem[]
}) {
  const latest = usages.find(
    (item) => item.latestVersion !== null
  )?.latestVersion
  const worstSeverity = usages.reduce<PackageUsageItem["maxSeverity"]>(
    (worst, item) => {
      const rank = { low: 1, moderate: 2, high: 3, critical: 4 } as const
      if (item.maxSeverity === null) return worst
      if (worst === null) return item.maxSeverity
      return rank[item.maxSeverity] > rank[worst] ? item.maxSeverity : worst
    },
    null
  )
  const updateKind = usages[0]?.updateKind ?? "none"

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b p-3">
        <span className="font-heading text-sm">
          {name}
          <span className="text-muted-foreground">@{version}</span>
        </span>
        <SeverityBadge severity={worstSeverity} />
        {latest !== undefined && latest !== null && latest !== version && (
          <span className="font-heading text-xs">
            <span className="text-muted-foreground">→ </span>
            <span className={cn(UPDATE_CLASS[updateKind])}>{latest}</span>
          </span>
        )}
        <span className="ml-auto text-muted-foreground text-xs">
          {usages.length} project{usages.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="divide-y">
        {usages.map((usage) => (
          <div
            key={usage.projectId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 text-sm"
          >
            <Link
              to="/projects/$projectId"
              params={{ projectId: usage.projectId }}
              search={{ q: name }}
              className="font-heading hover:underline"
            >
              {usage.projectName}
            </Link>
            <span className="text-muted-foreground text-xs">
              {usage.owner}/{usage.repo}
            </span>
            {usage.depTypes.map((depType) => (
              <DepTypeBadge key={depType} depType={depType} />
            ))}
            <span className="text-muted-foreground text-xs">
              {usage.isDirect ? "direct" : `transitive · depth ${usage.depth}`}
            </span>
            {usage.declaredRange !== null && (
              <span className="font-heading text-muted-foreground text-xs">
                {usage.declaredRange}
              </span>
            )}
            {usage.workspaces.some((workspace) => workspace !== "") && (
              <span className="flex flex-wrap gap-1">
                {usage.workspaces
                  .filter((workspace) => workspace !== "")
                  .map((workspace) => (
                    <Badge
                      key={workspace}
                      variant="outline"
                      className="font-heading"
                    >
                      {workspace}
                    </Badge>
                  ))}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {usage.openFindings > 0 && (
                <Link
                  to="/projects/$projectId/vulnerabilities"
                  params={{ projectId: usage.projectId }}
                  search={{ q: name }}
                  className="text-muted-foreground text-xs hover:text-foreground"
                >
                  {usage.openFindings} open finding
                  {usage.openFindings === 1 ? "" : "s"}
                </Link>
              )}
              <SeverityBadge severity={usage.maxSeverity} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
