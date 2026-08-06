import { useState } from "react"
import { ExternalLink } from "lucide-react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { CopyButton } from "@/components/common/copy-button"
import { DepTypeBadge } from "@/components/common/dep-type-badge"
import { FixAvailability } from "@/components/common/fix-availability"
import { RoleGate } from "@/components/common/role-gate"
import { SeverityBadge } from "@/components/common/severity-badge"
import { useCreatePrFlow } from "@/features/pull-requests/create-pr-context"
import { formatAbsoluteDate } from "@/lib/format"
import type { FindingListItem, FindingState, Severity } from "../api"
import { useUnignoreFinding } from "../api"
import { IgnoreFindingDialog } from "./ignore-finding-dialog"

interface AdvisoryGroup {
  advisoryId: string
  advisoryUrl: string | null
  advisorySummary: string
  advisoryCvssScore: number | null
  severity: Severity
  findings: FindingListItem[]
}

/**
 * Groups a page of findings by advisoryId, preserving the server's severity
 * ordering (critical → low) since that's the order findings arrive in.
 */
function groupByAdvisory(items: readonly FindingListItem[]): AdvisoryGroup[] {
  const groups = new Map<string, AdvisoryGroup>()
  for (const item of items) {
    let group = groups.get(item.advisoryId)
    if (group === undefined) {
      group = {
        advisoryId: item.advisoryId,
        advisoryUrl: item.advisoryUrl,
        advisorySummary: item.advisorySummary,
        advisoryCvssScore: item.advisoryCvssScore,
        severity: item.severity,
        findings: [],
      }
      groups.set(item.advisoryId, group)
    }
    group.findings.push(item)
  }
  return [...groups.values()]
}

const STRIPE_CLASS: Record<Severity, string> = {
  critical: "border-l-severity-critical",
  high: "border-l-severity-high",
  moderate: "border-l-severity-moderate",
  low: "border-l-severity-low",
}

interface AdvisoryListProps {
  projectId: string
  items: readonly FindingListItem[]
  state: FindingState
  onSelectFinding: (findingId: string) => void
}

export function AdvisoryList({
  projectId,
  items,
  state,
  onSelectFinding,
}: AdvisoryListProps) {
  const groups = groupByAdvisory(items)

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <AdvisoryCard
          key={group.advisoryId}
          projectId={projectId}
          group={group}
          state={state}
          onSelectFinding={onSelectFinding}
        />
      ))}
    </div>
  )
}

function AdvisoryCard({
  projectId,
  group,
  state,
  onSelectFinding,
}: {
  projectId: string
  group: AdvisoryGroup
  state: FindingState
  onSelectFinding: (findingId: string) => void
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-l-2 bg-card",
        STRIPE_CLASS[group.severity]
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-3">
        <div className="group flex min-w-0 items-center gap-1.5">
          <SeverityBadge severity={group.severity} />
          <span className="font-heading text-sm">{group.advisoryId}</span>
          <CopyButton value={group.advisoryId} label="Copy advisory id" />
          {group.advisoryUrl !== null && (
            <a
              href={group.advisoryUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              <span className="sr-only">Open advisory</span>
            </a>
          )}
        </div>
        {group.advisoryCvssScore !== null && (
          <span className="shrink-0 font-heading text-xs text-muted-foreground">
            CVSS {group.advisoryCvssScore.toFixed(1)}
          </span>
        )}
      </div>
      <p className="px-3 pt-2.5 text-sm text-muted-foreground">
        {group.advisorySummary}
      </p>
      <div className="mt-2 divide-y">
        {group.findings.map((finding) => (
          <FindingRow
            key={finding.id}
            projectId={projectId}
            finding={finding}
            state={state}
            onSelect={() => onSelectFinding(finding.id)}
          />
        ))}
      </div>
    </div>
  )
}

function FindingRow({
  projectId,
  finding,
  state,
  onSelect,
}: {
  projectId: string
  finding: FindingListItem
  state: FindingState
  onSelect: () => void
}) {
  const [ignoreOpen, setIgnoreOpen] = useState(false)
  const unignoreFinding = useUnignoreFinding(projectId)
  const createPrFlow = useCreatePrFlow()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect()
      }}
      className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 p-3 text-sm hover:bg-muted/40"
    >
      <span className="font-heading">
        {finding.packageName}
        <span className="text-muted-foreground">@{finding.packageVersion}</span>
      </span>
      {finding.workspace !== "" && (
        <Badge variant="outline" className="font-heading">
          {finding.workspace}
        </Badge>
      )}
      <DepTypeBadge depType={finding.depType} />
      <span className="text-xs text-muted-foreground">
        {finding.isDirect ? "direct" : "transitive"}
      </span>
      <FixAvailability
        fixedIn={finding.fixedIn}
        fixType={finding.fixType}
        fixWithinRange={finding.fixWithinRange}
      />
      {state === "ignored" && (
        <span className="w-full text-xs text-muted-foreground">
          Ignored: {finding.ignoreReason}
          {finding.ignoreUntil !== null &&
            ` · until ${formatAbsoluteDate(finding.ignoreUntil)}`}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {finding.fixedIn !== null && (
          <RoleGate capability="createPr" mode="disable">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={(event) => {
                event.stopPropagation()
                createPrFlow.openWith([
                  {
                    name: finding.packageName,
                    workspace:
                      finding.workspace === "" ? undefined : finding.workspace,
                    toVersion: finding.fixedIn ?? undefined,
                    hint: "fix" as const,
                  },
                ])
              }}
            >
              Fix with PR
            </Button>
          </RoleGate>
        )}
        {state === "ignored" ? (
          <RoleGate capability="editProject" mode="disable">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={unignoreFinding.isPending}
              onClick={(event) => {
                event.stopPropagation()
                unignoreFinding.mutate(finding.id)
              }}
            >
              Unignore
            </Button>
          </RoleGate>
        ) : (
          <RoleGate capability="editProject" mode="disable">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={(event) => {
                event.stopPropagation()
                setIgnoreOpen(true)
              }}
            >
              Ignore…
            </Button>
          </RoleGate>
        )}
      </div>

      <IgnoreFindingDialog
        projectId={projectId}
        findingId={finding.id}
        packageName={finding.packageName}
        open={ignoreOpen}
        onOpenChange={setIgnoreOpen}
      />
    </div>
  )
}
