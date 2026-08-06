import { useQuery } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Separator } from "@workspace/ui/components/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { ExternalLink } from "lucide-react"
import { DepTypeBadge } from "@/components/common/dep-type-badge"
import { RoleGate } from "@/components/common/role-gate"
import { SeverityBadge } from "@/components/common/severity-badge"
import { VersionDelta } from "@/components/common/version-delta"
import { QueryBoundary } from "@/components/states/query-boundary"
import { useCreatePrFlow } from "@/features/pull-requests/create-pr-context"
import { dependencyDetailQueryOptions } from "../api"

interface DependencyDetailSheetProps {
  projectId: string
  /** null closes the sheet. */
  name: string | null
  onOpenChange: (open: boolean) => void
}

/** Row-click detail: versions in the tree, open findings, peer requirements. */
export function DependencyDetailSheet({
  projectId,
  name,
  onOpenChange,
}: DependencyDetailSheetProps) {
  const query = useQuery(dependencyDetailQueryOptions(projectId, name ?? ""))
  const createPrFlow = useCreatePrFlow()

  return (
    <Sheet open={name !== null} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-heading text-lg">{name}</SheetTitle>
          <SheetDescription>
            Versions in the tree, open findings, and peer requirements.
          </SheetDescription>
        </SheetHeader>

        {name !== null && (
          <div className="flex flex-col gap-6 px-4 pb-4">
            <QueryBoundary query={query}>
              {(detail) => (
                <>
                  <RoleGate capability="createPr" mode="disable">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      onClick={() => {
                        const primaryStatus = detail.statuses[0]
                        createPrFlow.openWith([
                          {
                            name,
                            workspace: primaryStatus?.workspace,
                            toVersion:
                              primaryStatus?.latestVersion ?? undefined,
                            hint: "latest" as const,
                          },
                        ])
                      }}
                    >
                      Create PR
                    </Button>
                  </RoleGate>

                  <section>
                    <h3 className="mb-2 font-medium text-sm">
                      Versions in tree
                    </h3>
                    <div className="flex flex-col gap-2">
                      {detail.occurrences.map((occurrence, index) => (
                        <div
                          key={index}
                          className="rounded-md border p-2.5 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-heading text-sm">
                              {occurrence.version}
                            </span>
                            <DepTypeBadge depType={occurrence.depType} />
                          </div>
                          <p className="mt-1 text-muted-foreground">
                            {occurrence.workspace === ""
                              ? "root"
                              : occurrence.workspace}
                            {" · "}
                            {occurrence.isDirect
                              ? "direct"
                              : `transitive (depth ${occurrence.depth})`}
                            {occurrence.declaredRange !== null && (
                              <>
                                {" · range "}
                                <span className="font-heading">
                                  {occurrence.declaredRange}
                                </span>
                              </>
                            )}
                          </p>
                          {occurrence.peerDeps !== null &&
                            Object.keys(occurrence.peerDeps).length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {Object.entries(occurrence.peerDeps).map(
                                  ([peerName, peer]) => (
                                    <Badge
                                      key={peerName}
                                      variant="outline"
                                      className="font-heading"
                                    >
                                      {peerName}@{peer.range}
                                      {peer.optional && " (optional)"}
                                    </Badge>
                                  )
                                )}
                              </div>
                            )}
                        </div>
                      ))}
                    </div>
                  </section>

                  {detail.statuses.length > 0 && (
                    <>
                      <Separator />
                      <section>
                        <h3 className="mb-2 font-medium text-sm">
                          Update status
                        </h3>
                        <div className="flex flex-col gap-2">
                          {detail.statuses.map((status, index) => (
                            <div
                              key={index}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <span className="text-muted-foreground">
                                {status.workspace === ""
                                  ? "root"
                                  : status.workspace}
                              </span>
                              {status.updateKind === "none" ? (
                                <span className="font-heading text-muted-foreground">
                                  up to date
                                </span>
                              ) : (
                                <VersionDelta
                                  current={status.currentVersion}
                                  target={status.latestVersion}
                                  updateKind={status.updateKind}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                        {detail.statuses.some(
                          (status) => status.deprecatedMessage !== null
                        ) && (
                          <p className="mt-2 text-destructive text-xs">
                            {
                              detail.statuses.find(
                                (status) => status.deprecatedMessage !== null
                              )?.deprecatedMessage
                            }
                          </p>
                        )}
                      </section>
                    </>
                  )}

                  <Separator />

                  <section>
                    <h3 className="mb-2 font-medium text-sm">
                      Open findings
                      {detail.findings.length > 0 &&
                        ` (${detail.findings.length})`}
                    </h3>
                    {detail.findings.length === 0 ? (
                      <p className="text-muted-foreground text-xs">
                        No open findings for this package.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {detail.findings.map((finding) => (
                          <div
                            key={finding.id}
                            className="rounded-md border p-2.5 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <SeverityBadge severity={finding.severity} />
                              {finding.advisoryUrl !== null && (
                                <a
                                  href={finding.advisoryUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                                >
                                  advisory
                                  <ExternalLink className="size-3" />
                                </a>
                              )}
                            </div>
                            <p className="mt-1.5">{finding.advisorySummary}</p>
                            {finding.fixedIn !== null && (
                              <p className="mt-1 text-muted-foreground">
                                Fixed in{" "}
                                <span className="font-heading">
                                  {finding.fixedIn}
                                </span>
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}
            </QueryBoundary>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
