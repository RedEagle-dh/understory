import { Link } from "@tanstack/react-router"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { ScanStatusPill } from "@/components/common/scan-status-pill"
import type { DashboardSummary } from "../api"

interface RecentScansProps {
  scans: DashboardSummary["recentScans"]
}

/** Findings delta of one scan: "+3 new · 1 resolved". Null deltas render nothing. */
function FindingsDelta({
  scan,
}: {
  scan: DashboardSummary["recentScans"][number]
}) {
  const parts: string[] = []
  if (scan.newFindings !== null && scan.newFindings > 0) {
    parts.push(`+${scan.newFindings} new`)
  }
  if (scan.resolvedFindings !== null && scan.resolvedFindings > 0) {
    parts.push(`${scan.resolvedFindings} resolved`)
  }
  if (parts.length === 0) return null
  return (
    <span className="font-heading text-muted-foreground text-xs">
      {parts.join(" · ")}
    </span>
  )
}

/** Fleet-wide activity feed: the last scans across every project. */
export function RecentScans({ scans }: RecentScansProps) {
  if (scans.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent scans</CardTitle>
      </CardHeader>
      <CardContent className="gap-2.5">
        {scans.map((scan) => (
          <div
            key={scan.id}
            className="flex items-center justify-between gap-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Link
                to="/projects/$projectId/scans/$scanId"
                params={{ projectId: scan.projectId, scanId: scan.id }}
                className="truncate font-heading text-sm hover:underline"
              >
                {scan.projectName}
              </Link>
              <FindingsDelta scan={scan} />
            </div>
            <ScanStatusPill
              scan={{
                status: scan.status,
                finishedAt: scan.finishedAt,
                errorCode: null,
              }}
              className="shrink-0"
            />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
