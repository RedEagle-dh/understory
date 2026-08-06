import { Card, CardContent } from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"

interface FleetStatsProps {
  projects: readonly {
    vulnCounts: {
      critical: number
      high: number
      moderate: number
      low: number
    }
    outdatedCount: number
  }[]
}

/** Four quiet KPI tiles: critical, high, total outdated, project count. */
export function FleetStats({ projects }: FleetStatsProps) {
  const totals = projects.reduce(
    (acc, project) => ({
      critical: acc.critical + project.vulnCounts.critical,
      high: acc.high + project.vulnCounts.high,
      outdated: acc.outdated + project.outdatedCount,
    }),
    { critical: 0, high: 0, outdated: 0 }
  )

  const tiles: { label: string; value: number; tint?: string }[] = [
    {
      label: "Critical",
      value: totals.critical,
      tint: totals.critical > 0 ? "text-severity-critical" : undefined,
    },
    {
      label: "High",
      value: totals.high,
      tint: totals.high > 0 ? "text-severity-high" : undefined,
    },
    { label: "Outdated", value: totals.outdated },
    { label: "Projects", value: projects.length },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label} size="sm">
          <CardContent className="gap-0.5">
            <span
              className={cn(
                "font-heading text-3xl font-semibold tracking-tight",
                tile.tint
              )}
            >
              {tile.value}
            </span>
            <span className="text-xs text-muted-foreground">{tile.label}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
