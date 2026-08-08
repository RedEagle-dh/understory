import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { Switch } from "@workspace/ui/components/switch"
import { toast } from "@workspace/ui/components/toast"
import { useEffect, useState } from "react"
import { ApiError } from "@/lib/api-error"
import type { ChannelListItem, ChannelType } from "../api"
import { useCreateChannel, useUpdateChannel } from "../api"
import { DiscordChannelForm } from "./discord-channel-form"
import { ResendChannelForm } from "./resend-channel-form"
import { SlackChannelForm } from "./slack-channel-form"
import { WebhookChannelForm } from "./webhook-channel-form"

interface AddChannelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present = edit mode. */
  channel?: ChannelListItem
}

const TYPE_LABELS: Record<ChannelType, string> = {
  email_resend: "Email (Resend)",
  discord_webhook: "Discord webhook",
  slack_webhook: "Slack webhook",
  webhook: "Webhook (generic)",
}

const TYPE_ORDER: ChannelType[] = [
  "email_resend",
  "discord_webhook",
  "slack_webhook",
  "webhook",
]

/** `Name: value` per line → a header object; blank and malformed lines are ignored. */
function parseHeaders(input: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of input.split("\n")) {
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (name !== "" && value !== "") out[name] = value
  }
  return out
}

interface FormState {
  name: string
  type: ChannelType
  enabled: boolean
  apiKey: string
  from: string
  to: string
  webhookUrl: string
  mention: string
  url: string
  secret: string
  headers: string
}

function emptyState(channel: ChannelListItem | undefined): FormState {
  const type: ChannelType = channel?.type ?? "email_resend"
  return {
    name: channel?.name ?? "",
    type,
    enabled: channel?.enabled ?? true,
    apiKey: "",
    from:
      channel !== undefined && type === "email_resend"
        ? String(channel.configPublic.from ?? "")
        : "",
    to:
      channel !== undefined &&
      type === "email_resend" &&
      Array.isArray(channel.configPublic.to)
        ? (channel.configPublic.to as unknown[]).join("\n")
        : "",
    webhookUrl: "",
    mention:
      channel !== undefined &&
      (type === "discord_webhook" || type === "slack_webhook")
        ? String(channel.configPublic.mention ?? "")
        : "",
    url:
      channel !== undefined &&
      type === "webhook" &&
      typeof channel.configPublic.host === "string"
        ? `https://${channel.configPublic.host}${String(
            channel.configPublic.path ?? ""
          )}`
        : "",
    secret: "",
    headers: "",
  }
}

/**
 * Type Select first, then the provider-specific fields. Create mode requires
 * the secret field(s); edit mode leaves them blank ("unchanged") — only a
 * non-empty value is sent, matching the API's partial-update semantics.
 */
export function AddChannelDialog({
  open,
  onOpenChange,
  channel,
}: AddChannelDialogProps) {
  const mode = channel === undefined ? "create" : "edit"
  const createChannel = useCreateChannel()
  const updateChannel = useUpdateChannel()
  const [state, setState] = useState<FormState>(() => emptyState(channel))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setState(emptyState(channel))
      setError(null)
    }
    // channel is only meaningful to re-derive from when the dialog (re)opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pending = createChannel.isPending || updateChannel.isPending

  const canSubmit =
    state.name.trim() !== "" &&
    (state.type === "email_resend"
      ? state.from.trim() !== "" &&
        state.to.trim() !== "" &&
        (mode === "edit" || state.apiKey.trim() !== "")
      : state.type === "webhook"
        ? state.url.trim() !== ""
        : mode === "edit" || state.webhookUrl.trim() !== "")

  const handleSubmit = async () => {
    setError(null)
    // Secret fields are omitted when blank, which the API reads as "keep the
    // stored value" — that is what makes edit mode work without ever sending
    // a secret back to the browser first.
    const config: Record<string, unknown> =
      state.type === "email_resend"
        ? {
            from: state.from.trim(),
            to: state.to
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line !== ""),
            ...(state.apiKey.trim() !== ""
              ? { apiKey: state.apiKey.trim() }
              : {}),
          }
        : state.type === "webhook"
          ? {
              url: state.url.trim(),
              ...(state.secret.trim() !== ""
                ? { secret: state.secret.trim() }
                : {}),
              ...(state.headers.trim() !== ""
                ? { headers: parseHeaders(state.headers) }
                : {}),
            }
          : {
              ...(state.mention.trim() !== ""
                ? { mention: state.mention.trim() }
                : {}),
              ...(state.webhookUrl.trim() !== ""
                ? { webhookUrl: state.webhookUrl.trim() }
                : {}),
            }

    try {
      if (mode === "create") {
        await createChannel.mutateAsync({
          name: state.name.trim(),
          type: state.type,
          config,
          enabled: state.enabled,
        })
        toast.add({ title: "Channel added" })
      } else if (channel !== undefined) {
        await updateChannel.mutateAsync({
          channelId: channel.id,
          name: state.name.trim(),
          enabled: state.enabled,
          config,
        })
        toast.add({ title: "Channel updated" })
      }
      onOpenChange(false)
    } catch (submitError) {
      if (submitError instanceof ApiError && submitError.status === 422) {
        setError(submitError.detail)
        return
      }
      throw submitError
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Add channel" : "Edit channel"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Send notifications to Discord, Slack, email, or any HTTP endpoint."
              : "Secret fields left blank keep their stored value."}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Field orientation="horizontal">
            <FieldLabel htmlFor="channel-type" className="flex-1">
              Type
            </FieldLabel>
            {mode === "create" ? (
              <Select
                value={state.type}
                onValueChange={(next) => {
                  if (next !== null) {
                    setState((prev) => ({ ...prev, type: next as ChannelType }))
                  }
                }}
              >
                <SelectTrigger id="channel-type" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_ORDER.map((type) => (
                    <SelectItem key={type} value={type}>
                      {TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-muted-foreground text-sm">
                {TYPE_LABELS[state.type]}
              </span>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="channel-name">Name</FieldLabel>
            <Input
              id="channel-name"
              value={state.name}
              onChange={(event) =>
                setState((prev) => ({ ...prev, name: event.target.value }))
              }
            />
          </Field>

          {state.type === "email_resend" ? (
            <ResendChannelForm
              mode={mode}
              apiKey={state.apiKey}
              onApiKeyChange={(value) =>
                setState((prev) => ({ ...prev, apiKey: value }))
              }
              from={state.from}
              onFromChange={(value) =>
                setState((prev) => ({ ...prev, from: value }))
              }
              to={state.to}
              onToChange={(value) =>
                setState((prev) => ({ ...prev, to: value }))
              }
            />
          ) : state.type === "slack_webhook" ? (
            <SlackChannelForm
              mode={mode}
              webhookUrl={state.webhookUrl}
              onWebhookUrlChange={(value) =>
                setState((prev) => ({ ...prev, webhookUrl: value }))
              }
              mention={state.mention}
              onMentionChange={(value) =>
                setState((prev) => ({ ...prev, mention: value }))
              }
            />
          ) : state.type === "webhook" ? (
            <WebhookChannelForm
              mode={mode}
              url={state.url}
              onUrlChange={(value) =>
                setState((prev) => ({ ...prev, url: value }))
              }
              secret={state.secret}
              onSecretChange={(value) =>
                setState((prev) => ({ ...prev, secret: value }))
              }
              headers={state.headers}
              onHeadersChange={(value) =>
                setState((prev) => ({ ...prev, headers: value }))
              }
            />
          ) : (
            <DiscordChannelForm
              mode={mode}
              webhookUrl={state.webhookUrl}
              onWebhookUrlChange={(value) =>
                setState((prev) => ({ ...prev, webhookUrl: value }))
              }
              mention={state.mention}
              onMentionChange={(value) =>
                setState((prev) => ({ ...prev, mention: value }))
              }
            />
          )}

          <Field orientation="horizontal">
            <FieldLabel htmlFor="channel-enabled" className="flex-1">
              Enabled
            </FieldLabel>
            <Switch
              id="channel-enabled"
              checked={state.enabled}
              onCheckedChange={(checked) =>
                setState((prev) => ({ ...prev, enabled: checked }))
              }
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || pending}
            onClick={() => void handleSubmit()}
          >
            {pending ? <Spinner /> : mode === "create" ? "Add channel" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
