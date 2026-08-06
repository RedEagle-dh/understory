import { useQuery } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import { Separator } from "@workspace/ui/components/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { ExternalLink } from "lucide-react"
import { CopyButton } from "@/components/common/copy-button"
import { DepTypeBadge } from "@/components/common/dep-type-badge"
import { FixAvailability } from "@/components/common/fix-availability"
import { RelativeTime } from "@/components/common/relative-time"
import { SeverityBadge } from "@/components/common/severity-badge"
import { QueryBoundary } from "@/components/states/query-boundary"
import { formatAbsoluteDate } from "@/lib/format"
import { findingQueryOptions } from "../api"

interface FindingDetailSheetProps {
  /** null closes the sheet. */
  findingId: string | null
  onOpenChange: (open: boolean) => void
}

/** Row-click detail: the finding plus its full advisory (aliases, ranges, sources). */
export function FindingDetailSheet({
  findingId,
  onOpenChange,
}: FindingDetailSheetProps) {
  const query = useQuery(findingQueryOptions(findingId ?? ""))

  return (
    <Sheet open={findingId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-heading text-lg">
            Finding detail
          </SheetTitle>
          <SheetDescription>
            Full advisory detail for this finding.
          </SheetDescription>
        </SheetHeader>

        {findingId !== null && (
          <div className="flex flex-col gap-6 px-4 pb-4">
            <QueryBoundary query={query}>
              {(finding) => (
                <>
                  <section className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={finding.severity} />
                      <span className="font-heading text-sm">
                        {finding.packageName}@{finding.packageVersion}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                      {finding.workspace !== "" && (
                        <Badge variant="outline" className="font-heading">
                          {finding.workspace}
                        </Badge>
                      )}
                      <DepTypeBadge depType={finding.depType} />
                      <span>{finding.isDirect ? "direct" : "transitive"}</span>
                    </div>
                    <FixAvailability
                      fixedIn={finding.fixedIn}
                      fixType={finding.fixType}
                      fixWithinRange={finding.fixWithinRange}
                    />
                    <p className="text-muted-foreground text-xs">
                      First seen <RelativeTime date={finding.firstSeenAt} />
                    </p>
                    {finding.state === "ignored" && (
                      <p className="text-muted-foreground text-xs">
                        Ignored: {finding.ignoreReason}
                        {finding.ignoreUntil !== null &&
                          ` · until ${formatAbsoluteDate(finding.ignoreUntil)}`}
                      </p>
                    )}
                  </section>

                  <Separator />

                  <section className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-heading text-sm">
                        {finding.advisory.id}
                      </h3>
                      <CopyButton
                        value={finding.advisory.id}
                        label="Copy advisory id"
                        className="opacity-100"
                      />
                      {finding.advisory.url !== null && (
                        <a
                          href={finding.advisory.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground hover:underline"
                        >
                          advisory
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                    <p className="text-sm">{finding.advisory.summary}</p>
                    {finding.advisory.details !== null && (
                      <p className="text-muted-foreground text-xs">
                        {finding.advisory.details}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
                      {finding.advisory.cvssScore !== null && (
                        <span className="font-heading">
                          CVSS {finding.advisory.cvssScore.toFixed(1)}
                        </span>
                      )}
                      {finding.advisory.cvssVector !== null && (
                        <span className="font-heading">
                          {finding.advisory.cvssVector}
                        </span>
                      )}
                    </div>
                    {finding.advisory.cweIds.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {finding.advisory.cweIds.map((cwe) => (
                          <Badge
                            key={cwe}
                            variant="outline"
                            className="font-heading"
                          >
                            {cwe}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </section>

                  {finding.advisory.aliases.length > 0 && (
                    <>
                      <Separator />
                      <section>
                        <h3 className="mb-2 font-medium text-sm">Aliases</h3>
                        <div className="flex flex-wrap gap-1">
                          {finding.advisory.aliases.map((alias) => (
                            <Badge
                              key={alias}
                              variant="outline"
                              className="font-heading"
                            >
                              {alias}
                            </Badge>
                          ))}
                        </div>
                      </section>
                    </>
                  )}

                  {finding.advisory.ranges.length > 0 && (
                    <>
                      <Separator />
                      <section>
                        <h3 className="mb-2 font-medium text-sm">
                          Vulnerable ranges
                        </h3>
                        <div className="flex flex-col gap-1.5">
                          {finding.advisory.ranges.map((range, index) => (
                            <div
                              key={index}
                              className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs"
                            >
                              <span className="font-heading">
                                {range.packageName}
                              </span>
                              <span className="font-heading text-muted-foreground">
                                {range.vulnerableRange}
                              </span>
                              {range.firstPatched !== null && (
                                <span className="font-heading text-severity-low">
                                  patched {range.firstPatched}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </section>
                    </>
                  )}

                  {finding.advisory.sources.length > 0 && (
                    <>
                      <Separator />
                      <section>
                        <h3 className="mb-2 font-medium text-sm">Sources</h3>
                        <div className="flex flex-wrap gap-1.5">
                          {finding.advisory.sources.map((source) => (
                            <Badge
                              key={source.source}
                              variant="secondary"
                              className="font-heading"
                            >
                              {source.source}
                            </Badge>
                          ))}
                        </div>
                      </section>
                    </>
                  )}
                </>
              )}
            </QueryBoundary>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
