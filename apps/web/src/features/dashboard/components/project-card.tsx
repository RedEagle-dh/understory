import { Link } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { Card, CardContent } from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"
import { ScanNowButton } from "@/components/common/scan-now-button"
import { ScanStatusPill } from "@/components/common/scan-status-pill"
import { SeverityBar } from "@/components/common/severity-bar"
import { SeveritySpectrum } from "@/components/common/severity-spectrum"
import { hasRunningScan } from "@/features/projects/lib"

interface ProjectCardProps {
  project: {
    id: string
    name: string
    owner: string
    repo: string
    branch: string
    paused: boolean
    vulnCounts: {
      critical: number
      high: number
      moderate: number
      low: number
    }
    outdatedCount: number
    majorOutdatedCount: number
    lastScan: {
      status: "running" | "ok" | "failed"
      finishedAt: Date | string | null
      errorCode: string | null
    } | null
  }
}

/**
 * Whole-card link to the project. The severity spectrum only shows up when
 * there's at least one open finding — DESIGN.md is explicit that severity
 * colors never decorate, so a clean project renders with no strip at all.
 */
export function ProjectCard({ project }: ProjectCardProps) {
  const totalVulns =
    project.vulnCounts.critical +
    project.vulnCounts.high +
    project.vulnCounts.moderate +
    project.vulnCounts.low

  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card
        className={cn(
          "h-full gap-3 pt-0 transition-shadow hover:shadow-md",
          project.paused && "opacity-60"
        )}
      >
        {totalVulns > 0 && <SeveritySpectrum />}
        <CardContent
          className={cn("gap-3", totalVulns === 0 && "pt-(--card-spacing)")}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate font-heading font-medium text-base">
                  {project.name}
                </h3>
                {project.paused && <Badge variant="outline">paused</Badge>}
              </div>
              <p className="truncate font-heading text-muted-foreground text-xs">
                {project.owner}/{project.repo}
                {project.branch !== "" && `@${project.branch}`}
              </p>
            </div>
            <ScanStatusPill scan={project.lastScan} className="shrink-0" />
          </div>

          <SeverityBar counts={project.vulnCounts} />

          <div className="flex items-center justify-between gap-2">
            <p className="font-heading text-muted-foreground text-xs">
              {project.outdatedCount} outdated
              {project.majorOutdatedCount > 0 &&
                ` · ${project.majorOutdatedCount} major`}
            </p>
            <ScanNowButton
              projectId={project.id}
              running={hasRunningScan(project.lastScan)}
            />
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
