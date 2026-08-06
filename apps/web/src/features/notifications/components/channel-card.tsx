import { Button } from "@workspace/ui/components/button"
import { Card, CardContent } from "@workspace/ui/components/card"
import { Spinner } from "@workspace/ui/components/spinner"
import { Switch } from "@workspace/ui/components/switch"
import { toast } from "@workspace/ui/components/toast"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { Mail, MessageSquare, Pencil, Trash2 } from "lucide-react"
import { useState } from "react"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { RelativeTime } from "@/components/common/relative-time"
import { RoleGate } from "@/components/common/role-gate"
import { ApiError } from "@/lib/api-error"
import type { ChannelListItem } from "../api"
import { useDeleteChannel, useTestChannel, useUpdateChannel } from "../api"
import { AddChannelDialog } from "./add-channel-dialog"

function targetSummary(channel: ChannelListItem): string {
  if (channel.type === "email_resend") {
    const to = channel.configPublic.to
    return Array.isArray(to) ? to.join(", ") : ""
  }
  const host =
    typeof channel.configPublic.host === "string"
      ? channel.configPublic.host
      : "discord.com"
  const webhookId =
    typeof channel.configPublic.webhookId === "string"
      ? channel.configPublic.webhookId
      : ""
  return webhookId === "" ? host : `${host}/…/${webhookId.slice(0, 8)}…`
}

export function ChannelCard({ channel }: { channel: ChannelListItem }) {
  const testChannel = useTestChannel()
  const updateChannel = useUpdateChannel()
  const deleteChannel = useDeleteChannel()
  const [editOpen, setEditOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    message?: string
  } | null>(null)

  const Icon = channel.type === "email_resend" ? Mail : MessageSquare

  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="font-medium">{channel.name}</span>
              {!channel.enabled && (
                <span className="text-muted-foreground text-xs">disabled</span>
              )}
            </div>
            <p className="truncate font-heading text-muted-foreground text-xs">
              {targetSummary(channel)}
            </p>
            {channel.lastError !== null ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <p className="cursor-default truncate text-destructive text-xs" />
                  }
                >
                  Last delivery failed
                </TooltipTrigger>
                <TooltipContent>{channel.lastError}</TooltipContent>
              </Tooltip>
            ) : channel.lastSuccessAt !== null ? (
              <p className="text-muted-foreground text-xs">
                Last delivered <RelativeTime date={channel.lastSuccessAt} />
              </p>
            ) : null}
            {testResult !== null && (
              <p
                className={
                  testResult.ok
                    ? "text-severity-low text-xs"
                    : "text-destructive text-xs"
                }
              >
                {testResult.ok
                  ? "Test succeeded"
                  : (testResult.message ?? "Test failed")}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <RoleGate capability="manageNotifications" mode="disable">
            <Switch
              checked={channel.enabled}
              onCheckedChange={(checked) =>
                updateChannel.mutate({
                  channelId: channel.id,
                  enabled: checked,
                })
              }
              aria-label={
                channel.enabled ? "Disable channel" : "Enable channel"
              }
            />
          </RoleGate>
          <RoleGate capability="manageNotifications" mode="disable">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testChannel.isPending}
              onClick={() => {
                setTestResult(null)
                testChannel.mutate(channel.id, {
                  onSuccess: (result) =>
                    setTestResult(
                      result.ok
                        ? { ok: true }
                        : { ok: false, message: result.error }
                    ),
                  onError: (error) =>
                    setTestResult({
                      ok: false,
                      message:
                        error instanceof ApiError
                          ? error.detail
                          : "Test failed.",
                    }),
                })
              }}
            >
              {testChannel.isPending ? <Spinner /> : "Test"}
            </Button>
          </RoleGate>
          <RoleGate capability="manageNotifications" mode="disable">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Edit channel"
              onClick={() => setEditOpen(true)}
            >
              <Pencil />
            </Button>
          </RoleGate>
          <RoleGate capability="manageNotifications" mode="disable">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete channel"
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 />
            </Button>
          </RoleGate>
        </div>
      </CardContent>

      <AddChannelDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        channel={channel}
      />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete channel"
        description={`Delete "${channel.name}"? Its notification rules are removed too.`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await deleteChannel.mutateAsync(channel.id)
          toast.add({ title: "Channel deleted" })
        }}
      />
    </Card>
  )
}
