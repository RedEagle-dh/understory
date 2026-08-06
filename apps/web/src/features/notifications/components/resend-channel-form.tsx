import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"

interface ResendChannelFormProps {
  mode: "create" | "edit"
  apiKey: string
  onApiKeyChange: (value: string) => void
  from: string
  onFromChange: (value: string) => void
  to: string
  onToChange: (value: string) => void
}

/** email_resend provider fields: API key (write-only), from address, one-recipient-per-line textarea. */
export function ResendChannelForm({
  mode,
  apiKey,
  onApiKeyChange,
  from,
  onFromChange,
  to,
  onToChange,
}: ResendChannelFormProps) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="resend-api-key">API key</FieldLabel>
        <Input
          id="resend-api-key"
          type="password"
          autoComplete="off"
          placeholder={mode === "edit" ? "unchanged" : undefined}
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
        />
        <FieldDescription>
          Create a key at{" "}
          <a
            href="https://resend.com/api-keys"
            target="_blank"
            rel="noreferrer"
          >
            resend.com/api-keys
          </a>
          .
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="resend-from">From address</FieldLabel>
        <Input
          id="resend-from"
          type="email"
          placeholder="alerts@yourdomain.com"
          value={from}
          onChange={(event) => onFromChange(event.target.value)}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="resend-to">Recipients</FieldLabel>
        <Textarea
          id="resend-to"
          placeholder={"team@yourdomain.com\nsecurity@yourdomain.com"}
          value={to}
          onChange={(event) => onToChange(event.target.value)}
        />
        <FieldDescription>One email address per line.</FieldDescription>
      </Field>
    </FieldGroup>
  )
}
