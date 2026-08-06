import { cn } from "@workspace/ui/lib/utils"

type Severity = "low" | "moderate" | "high" | "critical"

const CLASSES: Record<Severity, string> = {
  critical: "bg-severity-critical text-white",
  high: "bg-severity-high text-white",
  moderate: "bg-severity-moderate text-black",
  low: "bg-severity-low text-white",
}

interface SeverityBadgeProps {
  severity: Severity | null
  count?: number
  className?: string
}

/** Filled severity chip (contrast-correct text per swatch); null renders a muted dash. */
export function SeverityBadge({
  severity,
  count,
  className,
}: SeverityBadgeProps) {
  if (severity === null) {
    return (
      <span className={cn("text-sm text-muted-foreground", className)}>—</span>
    )
  }

  return (
    <span
      className={cn(
        "inline-flex h-5 w-fit items-center gap-1 rounded-full px-2 font-heading text-xs font-medium whitespace-nowrap",
        CLASSES[severity],
        className
      )}
    >
      {severity}
      {count !== undefined && count > 1 && (
        <span className="opacity-80">×{count}</span>
      )}
    </span>
  )
}
