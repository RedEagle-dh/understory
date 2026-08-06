import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

interface SeverityCounts {
  critical: number
  high: number
  moderate: number
  low: number
}

const SEGMENTS: {
  key: keyof SeverityCounts
  label: string
  bar: string
}[] = [
  { key: "critical", label: "Critical", bar: "bg-chart-severity-critical" },
  { key: "high", label: "High", bar: "bg-chart-severity-high" },
  { key: "moderate", label: "Moderate", bar: "bg-chart-severity-moderate" },
  { key: "low", label: "Low", bar: "bg-chart-severity-low" },
]

interface SeverityBarProps {
  counts: SeverityCounts
  className?: string
}

/**
 * Horizontal stacked bar of open-vulnerability counts by severity
 * (critical → low). Empty state is a thin muted bar, not an empty stack —
 * absence of risk should read as calm, not as a rendering glitch.
 */
export function SeverityBar({ counts, className }: SeverityBarProps) {
  const total = counts.critical + counts.high + counts.moderate + counts.low

  if (total === 0) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <div className="h-1.5 flex-1 rounded-full bg-muted" />
        <span className="text-xs text-muted-foreground">
          no known vulnerabilities
        </span>
      </div>
    )
  }

  const segments = SEGMENTS.filter((segment) => counts[segment.key] > 0)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex h-4 w-full overflow-hidden rounded-full bg-muted",
              className
            )}
          />
        }
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={cn("flex items-center justify-center", segment.bar)}
            style={{ width: `${(counts[segment.key] / total) * 100}%` }}
          >
            <span className="hidden font-heading text-[10px] font-medium text-background sm:inline">
              {counts[segment.key]}
            </span>
          </div>
        ))}
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5 font-heading text-xs">
          {segments.map((segment) => (
            <span key={segment.key}>
              {segment.label}: {counts[segment.key]}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
