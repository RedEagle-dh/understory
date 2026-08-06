import { useQuery } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"
import { Switch } from "@workspace/ui/components/switch"
import { Trash2 } from "lucide-react"
import { RoleGate } from "@/components/common/role-gate"
import { SeverityBadge } from "@/components/common/severity-badge"
import { QueryBoundary } from "@/components/states/query-boundary"
import type { RuleListItem } from "../api"
import {
  channelsQueryOptions,
  EVENT_TYPE_LABELS,
  rulesQueryOptions,
  SEVERITY_SCOPED_EVENT_TYPES,
  useDeleteRule,
  useUpsertRule,
} from "../api"
import { RuleForm } from "./rule-form"

interface RuleRowProps {
  rule: RuleListItem
  channelName: string
  projectId: string
}

function RuleRow({ rule, channelName, projectId }: RuleRowProps) {
  const upsertRule = useUpsertRule(projectId)
  const deleteRule = useDeleteRule(projectId)
  const severityScoped = SEVERITY_SCOPED_EVENT_TYPES.has(rule.eventType)

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm">
      <span className="w-40 truncate font-medium">{channelName}</span>
      <span className="flex-1 text-muted-foreground">
        {EVENT_TYPE_LABELS[rule.eventType]}
      </span>
      {severityScoped &&
        (rule.minSeverity === null ? (
          <span className="text-muted-foreground text-xs">any severity</span>
        ) : (
          <SeverityBadge severity={rule.minSeverity} />
        ))}
      <RoleGate capability="manageNotifications" mode="disable">
        <Switch
          checked={rule.enabled}
          onCheckedChange={(checked) =>
            upsertRule.mutate({
              channelId: rule.channelId,
              eventType: rule.eventType,
              minSeverity: rule.minSeverity,
              enabled: checked,
            })
          }
          aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
        />
      </RoleGate>
      <RoleGate capability="manageNotifications" mode="disable">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Delete rule"
          disabled={deleteRule.isPending}
          onClick={() => deleteRule.mutate(rule.id)}
        >
          {deleteRule.isPending ? <Spinner /> : <Trash2 />}
        </Button>
      </RoleGate>
    </div>
  )
}

interface RuleListProps {
  /** '' (or omitted) = the global scope, matching `rulesQueryOptions`. */
  projectId?: string
}

/** Shared by `/settings/notifications` (global scope) and per-project settings. */
export function RuleList({ projectId = "" }: RuleListProps) {
  const channelsQuery = useQuery(channelsQueryOptions())
  const rulesQuery = useQuery(rulesQueryOptions(projectId))

  return (
    <div className="space-y-3">
      <h2 className="font-heading font-medium text-base">
        {projectId === "" ? "Global rules" : "Rules for this project"}
      </h2>

      <QueryBoundary query={channelsQuery}>
        {(channelsData) => (
          <QueryBoundary query={rulesQuery}>
            {(rulesData) => {
              const channelById = new Map(
                channelsData.items.map((channel) => [channel.id, channel])
              )
              return (
                <div className="space-y-3">
                  {rulesData.items.length > 0 && (
                    <div className="space-y-2">
                      {rulesData.items.map((rule) => (
                        <RuleRow
                          key={rule.id}
                          rule={rule}
                          channelName={
                            channelById.get(rule.channelId)?.name ??
                            "Unknown channel"
                          }
                          projectId={projectId}
                        />
                      ))}
                    </div>
                  )}
                  <RuleForm
                    projectId={projectId}
                    channels={channelsData.items}
                  />
                </div>
              )
            }}
          </QueryBoundary>
        )}
      </QueryBoundary>
    </div>
  )
}
