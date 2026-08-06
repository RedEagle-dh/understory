import { Button } from "@workspace/ui/components/button"
import { Field, FieldDescription } from "@workspace/ui/components/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { Plus } from "lucide-react"
import { useState } from "react"
import { SeverityBadge } from "@/components/common/severity-badge"
import type { ChannelListItem, EventType, Severity } from "../api"
import {
  EVENT_TYPE_LABELS,
  EVENT_TYPES,
  SEVERITY_SCOPED_EVENT_TYPES,
  useUpsertRule,
} from "../api"

const SEVERITIES: Severity[] = ["low", "moderate", "high", "critical"]

interface RuleFormProps {
  /** '' (or omitted) = the global scope. */
  projectId?: string
  channels: ChannelListItem[]
}

/**
 * The "add a rule" composer, shared between the global notifications screen
 * and per-project settings (`RuleList` renders one below the existing rows).
 * Saving upserts on (channel, scope, eventType) — see `useUpsertRule`.
 */
export function RuleForm({ projectId = "", channels }: RuleFormProps) {
  const upsertRule = useUpsertRule(projectId)
  const [channelId, setChannelId] = useState<string>(channels[0]?.id ?? "")
  const [eventType, setEventType] = useState<EventType>("new_vulnerabilities")
  const [minSeverity, setMinSeverity] = useState<Severity | "">("")

  const severityScoped = SEVERITY_SCOPED_EVENT_TYPES.has(eventType)

  if (channels.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Add a channel above before creating rules.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
      <Field className="w-44">
        <Select
          // Maps the selected id to its display name — without this the
          // trigger renders the raw channel id.
          items={Object.fromEntries(
            channels.map((channel) => [channel.id, channel.name])
          )}
          value={channelId}
          onValueChange={(next) => {
            if (next !== null) setChannelId(next)
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Channel" />
          </SelectTrigger>
          <SelectContent>
            {channels.map((channel) => (
              <SelectItem key={channel.id} value={channel.id}>
                {channel.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field className="w-56">
        <Select
          items={EVENT_TYPE_LABELS}
          value={eventType}
          onValueChange={(next) => {
            if (next !== null) setEventType(next as EventType)
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVENT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {EVENT_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field className="w-40">
        <Select
          value={minSeverity === "" ? "any" : minSeverity}
          onValueChange={(next) => {
            if (next === null) return
            setMinSeverity(next === "any" ? "" : (next as Severity))
          }}
          disabled={!severityScoped}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any severity</SelectItem>
            {SEVERITIES.map((severity) => (
              <SelectItem key={severity} value={severity}>
                <SeverityBadge severity={severity} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!severityScoped && (
          <FieldDescription>
            Only applies to vulnerability events.
          </FieldDescription>
        )}
      </Field>

      <Button
        type="button"
        size="sm"
        disabled={channelId === "" || upsertRule.isPending}
        onClick={() =>
          upsertRule.mutate({
            channelId,
            eventType,
            minSeverity:
              severityScoped && minSeverity !== "" ? minSeverity : null,
            enabled: true,
          })
        }
      >
        {upsertRule.isPending ? <Spinner /> : <Plus />}
        Add rule
      </Button>
    </div>
  )
}
