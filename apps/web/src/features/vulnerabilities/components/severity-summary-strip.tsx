import { cn } from "@workspace/ui/lib/utils"
import { SeverityBadge } from "@/components/common/severity-badge"
import type { Severity, VulnSummary } from "../api"

const SEVERITIES: Severity[] = ["critical", "high", "moderate", "low"]

interface SeveritySummaryStripProps {
  counts: VulnSummary["open"]
  active?: Severity
  onChange: (severity: Severity | undefined) => void
}

/**
 * Per-severity count pills, doubling as filter toggles: clicking a pill sets
 * (or clears, if already active) the severity search param. The inactive
 * pills dim rather than disappear once one is selected, so the full ramp
 * stays visible.
 */
export function SeveritySummaryStrip({
  counts,
  active,
  onChange,
}: SeveritySummaryStripProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {SEVERITIES.map((severity) => {
        const isActive = active === severity
        return (
          <button
            key={severity}
            type="button"
            onClick={() => onChange(isActive ? undefined : severity)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1 transition-colors hover:bg-muted/60",
              isActive && "border-foreground/20 bg-muted",
              active !== undefined && !isActive && "opacity-50"
            )}
          >
            <SeverityBadge severity={severity} />
            <span className="font-heading text-muted-foreground text-xs">
              {counts[severity]}
            </span>
          </button>
        )
      })}
    </div>
  )
}
