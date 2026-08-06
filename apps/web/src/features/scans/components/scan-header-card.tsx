import { Badge } from "@workspace/ui/components/badge"
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card"
import { ExternalLink } from "lucide-react"
import { RelativeTime } from "@/components/common/relative-time"
import { ScanStatusPill } from "@/components/common/scan-status-pill"
import { SeverityBar } from "@/components/common/severity-bar"
import type { ScanDetail } from "../api"
import { formatDuration, TRIGGER_LABEL, TRIGGER_VARIANT } from "../lib"

interface ScanHeaderCardProps {
  scan: ScanDetail
  owner?: string
  repo?: string
}

function Counter({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <p className="font-heading font-medium text-lg">{value ?? "—"}</p>
      <p className="text-muted-foreground text-xs">{label}</p>
    </div>
  )
}

/** Status, trigger, timing, commit/branch, and dependency + vulnerability counters for one scan. */
export function ScanHeaderCard({ scan, owner, repo }: ScanHeaderCardProps) {
  const commitHref =
    scan.commitSha !== null && owner !== undefined && repo !== undefined
      ? `https://github.com/${owner}/${repo}/commit/${scan.commitSha}`
      : null

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <ScanStatusPill scan={scan} />
            <Badge
              variant={TRIGGER_VARIANT[scan.trigger]}
              className="font-heading"
            >
              {TRIGGER_LABEL[scan.trigger]}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
            <span>
              Started <RelativeTime date={scan.startedAt} />
            </span>
            {scan.finishedAt !== null && (
              <span>
                Finished <RelativeTime date={scan.finishedAt} />
              </span>
            )}
            <span className="font-heading">
              {formatDuration(scan.durationMs)}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          {scan.commitSha !== null &&
            (commitHref !== null ? (
              <a
                href={commitHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-heading hover:text-foreground hover:underline"
              >
                {scan.commitSha.slice(0, 7)}
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="font-heading">{scan.commitSha.slice(0, 7)}</span>
            ))}
          {scan.branch !== null && scan.branch !== "" && (
            <Badge variant="outline" className="font-heading">
              {scan.branch}
            </Badge>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Counter label="Dependencies" value={scan.totalDeps} />
          <Counter label="Direct" value={scan.directDeps} />
          <Counter label="Outdated" value={scan.outdatedCount} />
          <Counter label="Major outdated" value={scan.majorOutdatedCount} />
        </div>

        <div className="mt-4">
          <SeverityBar
            counts={{
              critical: scan.vulnCritical ?? 0,
              high: scan.vulnHigh ?? 0,
              moderate: scan.vulnModerate ?? 0,
              low: scan.vulnLow ?? 0,
            }}
          />
        </div>
      </CardContent>
    </Card>
  )
}
