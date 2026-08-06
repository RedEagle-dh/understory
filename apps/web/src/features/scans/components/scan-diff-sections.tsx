import { useQuery } from "@tanstack/react-query"
import { FixAvailability } from "@/components/common/fix-availability"
import { SeverityBadge } from "@/components/common/severity-badge"
import { VersionDelta } from "@/components/common/version-delta"
import { QueryBoundary } from "@/components/states/query-boundary"
import { scanDiffQueryOptions } from "../api"

interface DiffSectionProps {
  title: string
  children: React.ReactNode
}

function DiffSection({ title, children }: DiffSectionProps) {
  return (
    <section>
      <h3 className="mb-2 font-medium text-sm">{title}</h3>
      {children}
    </section>
  )
}

interface ScanDiffSectionsProps {
  scanId: string
}

/**
 * What changed since the previous scan: new / resolved findings and newly
 * available major bumps. Only rendered for `status: "ok"` scans.
 */
export function ScanDiffSections({ scanId }: ScanDiffSectionsProps) {
  const query = useQuery(scanDiffQueryOptions(scanId))

  return (
    <QueryBoundary query={query}>
      {(diff) => {
        const isEmpty =
          diff.newFindings.length === 0 &&
          diff.resolvedFindings.length === 0 &&
          diff.newMajors.length === 0

        if (isEmpty) {
          return (
            <p className="text-muted-foreground text-sm">
              No changes since the previous scan.
            </p>
          )
        }

        return (
          <div className="flex flex-col gap-6">
            <DiffSection title="New vulnerabilities">
              {diff.newFindings.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No new vulnerabilities.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {diff.newFindings.map((finding) => (
                    <div
                      key={finding.findingId}
                      className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-sm"
                    >
                      <SeverityBadge severity={finding.severity} />
                      <span className="font-heading">
                        {finding.packageName}
                        <span className="text-muted-foreground">
                          @{finding.packageVersion}
                        </span>
                      </span>
                      <FixAvailability
                        fixedIn={finding.fixedIn}
                        fixType={finding.fixType}
                      />
                      <span className="ml-auto max-w-md truncate text-muted-foreground text-xs">
                        {finding.summary}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </DiffSection>

            <DiffSection title="Resolved">
              {diff.resolvedFindings.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Nothing resolved.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {diff.resolvedFindings.map((finding) => (
                    <div
                      key={finding.findingId}
                      className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-muted-foreground text-sm"
                    >
                      <span className="font-heading">
                        {finding.packageName}@{finding.packageVersion}
                      </span>
                      <span className="text-xs">{finding.summary}</span>
                    </div>
                  ))}
                </div>
              )}
            </DiffSection>

            <DiffSection title="New majors available">
              {diff.newMajors.length === 0 ? (
                <p className="text-muted-foreground text-xs">No new majors.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {diff.newMajors.map((major, index) => (
                    <div
                      key={index}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5 text-sm"
                    >
                      <span className="font-heading">{major.packageName}</span>
                      <VersionDelta
                        current={
                          major.previousLatestVersion ?? major.currentVersion
                        }
                        target={major.latestVersion}
                        updateKind="major"
                      />
                    </div>
                  ))}
                </div>
              )}
            </DiffSection>
          </div>
        )
      }}
    </QueryBoundary>
  )
}
