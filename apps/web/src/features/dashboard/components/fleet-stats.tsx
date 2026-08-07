import { Card, CardContent } from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"
import type { DashboardSummary } from "../api"

interface FleetStatsProps {
  totals: DashboardSummary["totals"]
}

/** Quiet KPI tiles over the whole fleet, fed by `/api/dashboard`. */
export function FleetStats({ totals }: FleetStatsProps) {
  const tiles: { label: string; value: number; tint?: string }[] = [
    {
      label: "Critical",
      value: totals.openFindings.critical,
      tint:
        totals.openFindings.critical > 0 ? "text-severity-critical" : undefined,
    },
    {
      label: "High",
      value: totals.openFindings.high,
      tint: totals.openFindings.high > 0 ? "text-severity-high" : undefined,
    },
    { label: "Outdated", value: totals.outdatedDeps },
    { label: "Open PRs", value: totals.openPrs },
    {
      label: "Failing scans",
      value: totals.failingProjects,
      tint: totals.failingProjects > 0 ? "text-destructive" : undefined,
    },
    { label: "Projects", value: totals.projects },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <Card key={tile.label} size="sm">
          <CardContent className="gap-0.5">
            <span
              className={cn(
                "font-heading font-semibold text-3xl tracking-tight",
                tile.tint
              )}
            >
              {tile.value}
            </span>
            <span className="text-muted-foreground text-xs">{tile.label}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
