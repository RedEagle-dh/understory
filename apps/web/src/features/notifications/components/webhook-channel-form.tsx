import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"

interface WebhookChannelFormProps {
  mode: "create" | "edit"
  url: string
  onUrlChange: (value: string) => void
  secret: string
  onSecretChange: (value: string) => void
  headers: string
  onHeadersChange: (value: string) => void
}

/**
 * Generic webhook fields. The URL is not secret (it is shown back in the
 * channel list), but the shared secret and any custom headers are write-only.
 */
export function WebhookChannelForm({
  mode,
  url,
  onUrlChange,
  secret,
  onSecretChange,
  headers,
  onHeadersChange,
}: WebhookChannelFormProps) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="webhook-url">Endpoint URL</FieldLabel>
        <Input
          id="webhook-url"
          autoComplete="off"
          placeholder="https://example.internal/hooks/understory"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
        />
        <FieldDescription>
          Receives a POST with a JSON body describing the event.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="webhook-secret">
          Signing secret (optional)
        </FieldLabel>
        <Input
          id="webhook-secret"
          type="password"
          autoComplete="off"
          placeholder={mode === "edit" ? "unchanged" : "at least 8 characters"}
          value={secret}
          onChange={(event) => onSecretChange(event.target.value)}
        />
        <FieldDescription>
          Adds an <code>X-Understory-Signature</code> header:{" "}
          <code>sha256=HMAC(secret, "&lt;timestamp&gt;.&lt;body&gt;")</code>,
          with the timestamp in <code>X-Understory-Timestamp</code>.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="webhook-headers">
          Extra headers (optional)
        </FieldLabel>
        <Textarea
          id="webhook-headers"
          rows={3}
          autoComplete="off"
          placeholder={
            mode === "edit" ? "unchanged" : "Authorization: Bearer abc123"
          }
          value={headers}
          onChange={(event) => onHeadersChange(event.target.value)}
        />
        <FieldDescription>
          One <code>Name: value</code> per line.
        </FieldDescription>
      </Field>
    </FieldGroup>
  )
}
