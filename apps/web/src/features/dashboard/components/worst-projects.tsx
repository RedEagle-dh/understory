import { Link } from "@tanstack/react-router"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { SeverityBar } from "@/components/common/severity-bar"
import type { DashboardSummary } from "../api"

interface WorstProjectsProps {
  projects: DashboardSummary["worstProjects"]
}

function totalVulns(counts: {
  critical: number
  high: number
  moderate: number
  low: number
}) {
  return counts.critical + counts.high + counts.moderate + counts.low
}

/**
 * The projects carrying the most risk right now. Projects without open
 * findings are filtered out — an all-clear fleet renders nothing rather
 * than a list of zeros.
 */
export function WorstProjects({ projects }: WorstProjectsProps) {
  const withFindings = projects.filter(
    (project) => totalVulns(project.vulnCounts) > 0
  )
  if (withFindings.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
      </CardHeader>
      <CardContent className="gap-3">
        {withFindings.map((project) => (
          <Link
            key={project.id}
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            className="group grid grid-cols-[minmax(8rem,14rem)_1fr] items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate font-heading text-sm group-hover:underline">
              {project.name}
            </span>
            <SeverityBar counts={project.vulnCounts} />
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}
