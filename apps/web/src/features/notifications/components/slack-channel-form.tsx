import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"

interface SlackChannelFormProps {
  mode: "create" | "edit"
  webhookUrl: string
  onWebhookUrlChange: (value: string) => void
  mention: string
  onMentionChange: (value: string) => void
}

/** slack_webhook provider fields: incoming webhook URL (write-only) and an optional mention prefix. */
export function SlackChannelForm({
  mode,
  webhookUrl,
  onWebhookUrlChange,
  mention,
  onMentionChange,
}: SlackChannelFormProps) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="slack-webhook-url">Webhook URL</FieldLabel>
        <Input
          id="slack-webhook-url"
          type="password"
          autoComplete="off"
          placeholder={
            mode === "edit"
              ? "unchanged"
              : "https://hooks.slack.com/services/..."
          }
          value={webhookUrl}
          onChange={(event) => onWebhookUrlChange(event.target.value)}
        />
        <FieldDescription>
          From a Slack app's Incoming Webhooks page. The channel is fixed by the
          URL itself.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="slack-mention">Mention (optional)</FieldLabel>
        <Input
          id="slack-mention"
          placeholder="<!here> or <!subteam^S0123ABC>"
          value={mention}
          onChange={(event) => onMentionChange(event.target.value)}
        />
        <FieldDescription>
          Prefixed to every message. Slack needs the angle-bracket form, not
          plain <code>@here</code>.
        </FieldDescription>
      </Field>
    </FieldGroup>
  )
}
