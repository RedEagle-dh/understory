import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { NativeSelect } from "@workspace/ui/components/native-select"
import { cn } from "@workspace/ui/lib/utils"
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  SearchX,
  ShieldCheck,
} from "lucide-react"
import { z } from "zod"
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton"
import { DepTypeBadge } from "@/components/common/dep-type-badge"
import { FixAvailability } from "@/components/common/fix-availability"
import { RelativeTime } from "@/components/common/relative-time"
import { SeverityBadge } from "@/components/common/severity-badge"
import { EpssBadge, KevBadge } from "@/components/common/threat-badge"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import {
  inboxQueryOptions,
  inboxSummaryQueryOptions,
  type InboxItem,
} from "@/features/inbox/api"

const PAGE_SIZE = 25

const searchSchema = z.object({
  severity: z.enum(["low", "moderate", "high", "critical"]).optional(),
  kev: z.boolean().optional(),
  fixable: z.boolean().optional(),
  direct: z.boolean().optional(),
  q: z.string().optional(),
  sort: z.enum(["risk", "severity", "firstSeen"]).catch("risk").default("risk"),
  page: z.number().int().min(1).catch(1).default(1),
})

export const Route = createFileRoute("/_authed/vulnerabilities")({
  staticData: { crumb: "Vulnerabilities" },
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Vulnerabilities · understory" }] }),
  component: GlobalVulnerabilities,
})

const SEVERITIES = ["critical", "high", "moderate", "low"] as const

function GlobalVulnerabilities() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const summaryQuery = useQuery(inboxSummaryQueryOptions())
  const query = useQuery(
    inboxQueryOptions({
      severity: search.severity,
      kevOnly: search.kev,
      hasFix: search.fixable,
      direct: search.direct,
      q: search.q,
      sort: search.sort,
      page: search.page,
      pageSize: PAGE_SIZE,
    })
  )

  const hasActiveFilters =
    search.severity !== undefined ||
    search.kev === true ||
    search.fixable === true ||
    search.direct === true ||
    (search.q ?? "") !== ""

  const updateSearch = (patch: Partial<typeof search>) =>
    navigate({
      search: (prev) => ({ ...prev, ...patch, page: 1 }),
      replace: true,
    })

  const resetFilters = () =>
    navigate({
      search: (prev) => ({
        ...prev,
        severity: undefined,
        kev: undefined,
        fixable: undefined,
        direct: undefined,
        q: undefined,
        page: 1,
      }),
      replace: true,
    })

  const setPage = (page: number) =>
    navigate({ search: (prev) => ({ ...prev, page }), replace: true })

  const summary = summaryQuery.data

  return (
    <>
      <PageHeader
        title="Vulnerabilities"
        description="Every open finding across every tracked repository, ordered by how likely it is to be exploited rather than by severity alone."
      />

      {summary !== undefined && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {SEVERITIES.map((severity) => {
            const isActive = search.severity === severity
            return (
              <button
                key={severity}
                type="button"
                onClick={() =>
                  updateSearch({
                    severity: isActive ? undefined : severity,
                  })
                }
                className={cn(
                  "flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1 transition-colors hover:bg-muted/60",
                  isActive && "border-foreground/20 bg-muted",
                  search.severity !== undefined && !isActive && "opacity-50"
                )}
              >
                <SeverityBadge severity={severity} />
                <span className="font-heading text-sm">
                  {summary[severity]}
                </span>
              </button>
            )
          })}

          <button
            type="button"
            onClick={() =>
              updateSearch({ kev: search.kev === true ? undefined : true })
            }
            className={cn(
              "ml-2 flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1 transition-colors hover:bg-muted/60",
              search.kev === true && "border-foreground/20 bg-muted"
            )}
          >
            <KevBadge addedAt={new Date()} knownRansomware={null} />
            <span className="font-heading text-sm">{summary.kev}</span>
          </button>

          <span className="ml-auto font-heading text-muted-foreground text-xs">
            {summary.projects} project{summary.projects === 1 ? "" : "s"}{" "}
            affected
          </span>
        </div>
      )}

      <QueryBoundary query={query} skeleton={<DataTableSkeleton columns={6} />}>
        {(data) => {
          if (data.total === 0 && !hasActiveFilters) {
            return (
              <EmptyState
                icon={ShieldCheck}
                title="Nothing open anywhere"
                description="No tracked repository has an open vulnerability right now."
              />
            )
          }

          const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

          return (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={search.q ?? ""}
                  onChange={(event) =>
                    updateSearch({ q: event.target.value || undefined })
                  }
                  placeholder="Filter by package, advisory or project…"
                  className="h-8 w-full max-w-xs"
                />
                <Button
                  type="button"
                  variant={search.fixable === true ? "secondary" : "outline"}
                  size="sm"
                  onClick={() =>
                    updateSearch({
                      fixable: search.fixable === true ? undefined : true,
                    })
                  }
                >
                  Has fix
                </Button>
                <Button
                  type="button"
                  variant={search.direct === true ? "secondary" : "outline"}
                  size="sm"
                  onClick={() =>
                    updateSearch({
                      direct: search.direct === true ? undefined : true,
                    })
                  }
                >
                  Direct only
                </Button>
                <NativeSelect
                  value={search.sort}
                  onChange={(event) =>
                    updateSearch({
                      sort: event.target.value as typeof search.sort,
                    })
                  }
                  className="h-8 w-auto"
                  aria-label="Sort order"
                >
                  <option value="risk">Exploitation risk</option>
                  <option value="severity">Severity</option>
                  <option value="firstSeen">Newest</option>
                </NativeSelect>
                {hasActiveFilters && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={resetFilters}
                  >
                    Reset
                  </Button>
                )}
              </div>

              {data.total === 0 ? (
                <EmptyState
                  icon={SearchX}
                  title="No findings match these filters"
                  description="Try loosening or resetting the filters above."
                  action={
                    <Button variant="outline" onClick={resetFilters}>
                      Reset filters
                    </Button>
                  }
                />
              ) : (
                <>
                  <div className="divide-y overflow-hidden rounded-lg border bg-card">
                    {data.items.map((item) => (
                      <InboxRow key={item.id} item={item} />
                    ))}
                  </div>

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
    </>
  )
}

const STRIPE_CLASS = {
  critical: "border-l-severity-critical",
  high: "border-l-severity-high",
  moderate: "border-l-severity-moderate",
  low: "border-l-severity-low",
} as const

function InboxRow({ item }: { item: InboxItem }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-l-2 p-3",
        STRIPE_CLASS[item.severity]
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SeverityBadge severity={item.severity} />
        <KevBadge
          addedAt={item.kevAddedAt}
          knownRansomware={item.kevKnownRansomware}
        />
        <EpssBadge score={item.epssScore} percentile={item.epssPercentile} />
        <span className="font-heading text-sm">
          {item.packageName}
          <span className="text-muted-foreground">@{item.packageVersion}</span>
        </span>
        <DepTypeBadge depType={item.depType} />
        {!item.isDirect && (
          <span className="text-muted-foreground text-xs">transitive</span>
        )}
        <FixAvailability
          fixedIn={item.fixedIn}
          fixType={item.fixType}
          fixWithinRange={item.fixWithinRange}
        />
        <div className="ml-auto flex items-center gap-2">
          <RelativeTime
            date={item.firstSeenAt}
            className="font-heading text-muted-foreground text-xs"
          />
          <Link
            to="/projects/$projectId/vulnerabilities"
            params={{ projectId: item.projectId }}
            search={{ q: item.packageName }}
          >
            <Badge variant="outline" className="font-heading hover:bg-muted">
              {item.projectName}
            </Badge>
          </Link>
        </div>
      </div>

      <p className="text-muted-foreground text-sm">
        <span className="font-heading text-foreground">{item.advisoryId}</span>{" "}
        {item.advisorySummary}
        {item.advisoryUrl !== null && (
          <a
            href={item.advisoryUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-1 inline-flex items-center align-middle text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
            <span className="sr-only">Open advisory</span>
          </a>
        )}
      </p>
    </div>
  )
}
