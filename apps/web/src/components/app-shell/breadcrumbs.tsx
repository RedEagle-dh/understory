import { Fragment } from "react"
import { Link, useMatches } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/breadcrumb"
import { qk } from "@/lib/query-keys"

export function Breadcrumbs() {
  const matches = useMatches()
  const queryClient = useQueryClient()

  /**
   * Dynamic segments have no `staticData.crumb`. Params are inherited by
   * every child match, so the fallback only fires for the match whose own
   * route id declares the segment — otherwise the project id would repeat
   * once per matched route. The project's display name comes from the query
   * cache the project layout has already populated.
   */
  const fallbackLabel = (match: {
    routeId: string
    params: unknown
  }): string | undefined => {
    const params = match.params as Record<string, unknown> | null
    if (typeof params !== "object" || params === null) return undefined
    if (
      match.routeId.endsWith("$scanId") &&
      typeof params.scanId === "string"
    ) {
      return params.scanId
    }
    if (
      match.routeId.endsWith("$projectId") &&
      typeof params.projectId === "string"
    ) {
      const cached = queryClient.getQueryData(qk.project(params.projectId)) as
        { name?: string } | undefined
      return cached?.name ?? params.projectId
    }
    return undefined
  }

  const crumbs = matches
    .map((match) => ({
      id: match.id,
      path: match.pathname,
      label: match.staticData.crumb ?? fallbackLabel(match),
    }))
    .filter(
      (crumb): crumb is { id: string; path: string; label: string } =>
        crumb.label !== undefined
    )
    // Layout + index routes can still resolve to the same label — collapse.
    .filter((crumb, index, all) => crumb.label !== all[index - 1]?.label)

  if (crumbs.length === 0) return null

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.id}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {index === crumbs.length - 1 ? (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink render={<Link to={crumb.path} />}>
                  {crumb.label}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
