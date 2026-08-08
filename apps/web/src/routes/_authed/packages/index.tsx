import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { NativeSelect } from "@workspace/ui/components/native-select"
import { ChevronLeft, ChevronRight, Package, SearchX } from "lucide-react"
import { z } from "zod"
import { SeverityBadge } from "@/components/common/severity-badge"
import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton"
import { EmptyState } from "@/components/states/empty-state"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import {
  packagesQueryOptions,
  type PackageIndexItem,
} from "@/features/packages/api"

const PAGE_SIZE = 30

const searchSchema = z.object({
  q: z.string().optional(),
  ecosystem: z.enum(["npm", "pypi"]).optional(),
  direct: z.boolean().optional(),
  hasVuln: z.boolean().optional(),
  sort: z
    .enum(["name", "projects", "severity"])
    .catch("projects")
    .default("projects"),
  page: z.number().int().min(1).catch(1).default(1),
})

export const Route = createFileRoute("/_authed/packages/")({
  staticData: { crumb: "Packages" },
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Packages · understory" }] }),
  component: PackagesIndex,
})

function PackagesIndex() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const query = useQuery(
    packagesQueryOptions({
      q: search.q,
      ecosystem: search.ecosystem,
      direct: search.direct,
      hasVuln: search.hasVuln,
      sort: search.sort,
      page: search.page,
      pageSize: PAGE_SIZE,
    })
  )

  const hasActiveFilters =
    (search.q ?? "") !== "" ||
    search.ecosystem !== undefined ||
    search.direct !== undefined ||
    search.hasVuln === true

  const updateSearch = (patch: Partial<typeof search>) =>
    navigate({
      search: (prev) => ({ ...prev, ...patch, page: 1 }),
      replace: true,
    })

  const resetFilters = () =>
    navigate({
      search: (prev) => ({
        ...prev,
        q: undefined,
        ecosystem: undefined,
        direct: undefined,
        hasVuln: undefined,
        page: 1,
      }),
      replace: true,
    })

  const setPage = (page: number) =>
    navigate({ search: (prev) => ({ ...prev, page }), replace: true })

  return (
    <>
      <PageHeader
        title="Packages"
        description="Every package your tracked repositories depend on, and how many of them ship each one. Search here first when a package is compromised."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={search.q ?? ""}
          onChange={(event) =>
            updateSearch({ q: event.target.value || undefined })
          }
          placeholder="Search packages…"
          className="h-8 w-full max-w-xs"
        />
        <NativeSelect
          value={search.ecosystem ?? ""}
          onChange={(event) =>
            updateSearch({
              ecosystem:
                event.target.value === ""
                  ? undefined
                  : (event.target.value as "npm" | "pypi"),
            })
          }
          className="h-8 w-auto"
          aria-label="Ecosystem"
        >
          <option value="">All ecosystems</option>
          <option value="npm">npm</option>
          <option value="pypi">PyPI</option>
        </NativeSelect>
        <Button
          type="button"
          variant={search.hasVuln === true ? "secondary" : "outline"}
          size="sm"
          onClick={() =>
            updateSearch({
              hasVuln: search.hasVuln === true ? undefined : true,
            })
          }
        >
          Vulnerable only
        </Button>
        <Button
          type="button"
          variant={search.direct === true ? "secondary" : "outline"}
          size="sm"
          onClick={() =>
            updateSearch({ direct: search.direct === true ? undefined : true })
          }
        >
          Direct only
        </Button>
        <NativeSelect
          value={search.sort}
          onChange={(event) =>
            updateSearch({ sort: event.target.value as typeof search.sort })
          }
          className="h-8 w-auto"
          aria-label="Sort order"
        >
          <option value="projects">Most used</option>
          <option value="severity">Severity</option>
          <option value="name">Name</option>
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

      <QueryBoundary query={query} skeleton={<DataTableSkeleton columns={5} />}>
        {(data) => {
          if (data.total === 0 && !hasActiveFilters) {
            return (
              <EmptyState
                icon={Package}
                title="No dependencies indexed yet"
                description="Packages appear here once at least one project has completed a scan."
              />
            )
          }

          if (data.total === 0) {
            return (
              <EmptyState
                icon={SearchX}
                title="No packages match these filters"
                action={
                  <Button variant="outline" onClick={resetFilters}>
                    Reset filters
                  </Button>
                }
              />
            )
          }

          const pageCount = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

          return (
            <div className="flex flex-col gap-3">
              <div className="divide-y overflow-hidden rounded-lg border bg-card">
                {data.items.map((item) => (
                  <PackageRow
                    key={`${item.ecosystem}:${item.name}`}
                    item={item}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-heading text-muted-foreground text-xs">
                  {data.total} package{data.total === 1 ? "" : "s"}
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
            </div>
          )
        }}
      </QueryBoundary>
    </>
  )
}

function PackageRow({ item }: { item: PackageIndexItem }) {
  const extraVersions = item.versionCount - item.versions.length

  return (
    <Link
      to="/packages/$name"
      params={{ name: item.name }}
      search={{ ecosystem: item.ecosystem }}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 hover:bg-muted/40"
    >
      <span className="font-heading text-sm">{item.name}</span>
      {item.ecosystem === "pypi" && (
        <Badge variant="outline" className="font-heading">
          PyPI
        </Badge>
      )}
      <span className="text-muted-foreground text-xs">
        {item.projectCount} project{item.projectCount === 1 ? "" : "s"}
        {item.directProjectCount > 0 && ` · ${item.directProjectCount} direct`}
      </span>

      <span className="font-heading text-muted-foreground text-xs">
        {item.versions.join(", ")}
        {extraVersions > 0 && ` +${extraVersions}`}
      </span>

      <div className="ml-auto flex items-center gap-2">
        {item.openFindings > 0 && (
          <span className="text-muted-foreground text-xs">
            {item.openFindings} finding{item.openFindings === 1 ? "" : "s"} in{" "}
            {item.affectedProjects} project
            {item.affectedProjects === 1 ? "" : "s"}
          </span>
        )}
        <SeverityBadge severity={item.maxSeverity} />
      </div>
    </Link>
  )
}
