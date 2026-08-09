import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { Crosshair } from "lucide-react"
import { formatAbsoluteDate } from "@/lib/format"

/**
 * Exploitation signals, rendered next to — never instead of — severity.
 *
 * Both marks stay visually distinct from `SeverityBadge`: that one is a FILLED
 * chip on the severity ramp, these are an outline chip and plain mono text.
 * The critical hue on the KEV chip is not decorative — CISA listing a CVE
 * means exploitation has been observed in the wild, which is the most urgent
 * state this app can report about a finding.
 */

/** Above this probability the EPSS figure stops being background noise. */
const EPSS_LOUD = 0.1

export function KevBadge({
  addedAt,
  knownRansomware,
  className,
}: {
  addedAt: Date | string | null
  knownRansomware: boolean | null
  className?: string
}) {
  if (addedAt === null) return null
  const added = addedAt instanceof Date ? addedAt : new Date(addedAt)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex h-5 w-fit items-center gap-1 whitespace-nowrap rounded-full border border-severity-critical/60 px-1.5 font-heading font-medium text-severity-critical text-xs",
              className
            )}
          />
        }
      >
        <Crosshair className="size-3" aria-hidden />
        KEV
      </TooltipTrigger>
      <TooltipContent>
        Exploited in the wild — CISA added this to the Known Exploited
        Vulnerabilities catalogue on {formatAbsoluteDate(added)}
        {knownRansomware === true && ". Used in ransomware campaigns."}
      </TooltipContent>
    </Tooltip>
  )
}

/** EPSS probability as a percentage, keeping precision at the low end. */
export function formatEpss(score: number): string {
  if (score >= 0.1) return `${Math.round(score * 100)}%`
  if (score >= 0.001) return `${(score * 100).toFixed(1)}%`
  return "<0.1%"
}

export function EpssBadge({
  score,
  percentile,
  className,
}: {
  score: number | null
  percentile: number | null
  className?: string
}) {
  // A missing score is not a score of zero: EPSS only covers published CVEs,
  // so rendering "0%" here would claim a safety the data does not support.
  if (score === null) return null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "whitespace-nowrap font-heading text-xs",
              score >= EPSS_LOUD ? "text-foreground" : "text-muted-foreground",
              className
            )}
          />
        }
      >
        EPSS {formatEpss(score)}
      </TooltipTrigger>
      <TooltipContent>
        Estimated probability of exploitation within 30 days
        {percentile === null
          ? ""
          : ` — higher than ${Math.round(percentile * 100)}% of scored CVEs`}
      </TooltipContent>
    </Tooltip>
  )
}
