import { Badge } from "@workspace/ui/components/badge"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { RelativeTime } from "./relative-time"

interface ScanStatusPillProps {
  scan: {
    status: "running" | "ok" | "failed"
    finishedAt: Date | string | null
    errorCode: string | null
  } | null
  className?: string
}

/**
 * Small status readout reused on project cards and the project header:
 * never-scanned → "queued", running → spinner, ok → RelativeTime of the
 * finish, failed → destructive tone with the error code on hover.
 */
export function ScanStatusPill({ scan, className }: ScanStatusPillProps) {
  if (scan === null) {
    return (
      <Badge variant="outline" className={cn("font-heading", className)}>
        queued
      </Badge>
    )
  }

  if (scan.status === "running") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 font-heading text-xs text-muted-foreground",
          className
        )}
      >
        <Spinner className="size-3" />
        scanning
      </span>
    )
  }

  if (scan.status === "failed") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              variant="destructive"
              className={cn("font-heading", className)}
            />
          }
        >
          scan failed
        </TooltipTrigger>
        <TooltipContent>{scan.errorCode ?? "Unknown error"}</TooltipContent>
      </Tooltip>
    )
  }

  if (scan.finishedAt === null) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>—</span>
    )
  }

  return (
    <RelativeTime
      date={scan.finishedAt}
      className={cn("font-heading text-xs text-muted-foreground", className)}
    />
  )
}
