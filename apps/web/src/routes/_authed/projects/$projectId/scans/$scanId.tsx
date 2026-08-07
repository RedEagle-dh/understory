import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { AlertTriangle } from "lucide-react"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { projectQueryOptions } from "@/features/projects/api"
import { scanQueryOptions } from "@/features/scans/api"
import { ScanDiffSections } from "@/features/scans/components/scan-diff-sections"
import { ScanHeaderCard } from "@/features/scans/components/scan-header-card"

export const Route = createFileRoute(
  "/_authed/projects/$projectId/scans/$scanId"
)({
  component: ScanDetail,
})

function ScanDetail() {
  const { projectId, scanId } = Route.useParams()
  const scanQuery = useQuery(scanQueryOptions(projectId, scanId))
  const projectQuery = useQuery(projectQueryOptions(projectId))

  return (
    <>
      <PageHeader
        title="Scan detail"
        description="What this scan found: dependency changes, new vulnerabilities, and outdated packages."
      />

      <QueryBoundary
        query={scanQuery}
        skeleton={
          <div className="space-y-4">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        }
      >
        {(scan) => (
          <div className="flex flex-col gap-6">
            <ScanHeaderCard
              scan={scan}
              owner={projectQuery.data?.owner}
              repo={projectQuery.data?.repo}
            />

            {scan.warnings.length > 0 && (
              <Alert>
                <AlertTriangle />
                <AlertTitle>
                  {scan.warnings.length === 1
                    ? "The scan completed with a warning"
                    : `The scan completed with ${scan.warnings.length} warnings`}
                </AlertTitle>
                <AlertDescription>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                    {scan.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {scan.status === "failed" && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>
                  Scan failed
                  {scan.errorCode !== null && (
                    <span className="ml-2 font-heading font-normal">
                      {scan.errorCode}
                    </span>
                  )}
                </AlertTitle>
                <AlertDescription>
                  {scan.errorMessage !== null ? (
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                      {scan.errorMessage}
                    </pre>
                  ) : (
                    "No further detail was recorded for this failure."
                  )}
                </AlertDescription>
              </Alert>
            )}

            {scan.status === "ok" && <ScanDiffSections scanId={scan.id} />}
          </div>
        )}
      </QueryBoundary>
    </>
  )
}
