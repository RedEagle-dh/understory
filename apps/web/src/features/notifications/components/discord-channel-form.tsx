import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"

interface DiscordChannelFormProps {
  mode: "create" | "edit"
  webhookUrl: string
  onWebhookUrlChange: (value: string) => void
  mention: string
  onMentionChange: (value: string) => void
}

/** discord_webhook provider fields: incoming webhook URL (write-only) and an optional mention prefix. */
export function DiscordChannelForm({
  mode,
  webhookUrl,
  onWebhookUrlChange,
  mention,
  onMentionChange,
}: DiscordChannelFormProps) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="discord-webhook-url">Webhook URL</FieldLabel>
        <Input
          id="discord-webhook-url"
          type="password"
          autoComplete="off"
          placeholder={
            mode === "edit"
              ? "unchanged"
              : "https://discord.com/api/webhooks/..."
          }
          value={webhookUrl}
          onChange={(event) => onWebhookUrlChange(event.target.value)}
        />
        <FieldDescription>
          From a Discord channel's Integrations → Webhooks settings.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="discord-mention">Mention (optional)</FieldLabel>
        <Input
          id="discord-mention"
          placeholder="<@&1234567890> or @here"
          value={mention}
          onChange={(event) => onMentionChange(event.target.value)}
        />
        <FieldDescription>Prefixed to every message.</FieldDescription>
      </Field>
    </FieldGroup>
  )
}
