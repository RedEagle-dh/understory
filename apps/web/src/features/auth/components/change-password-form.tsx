import { useState } from "react"
import { useForm } from "@tanstack/react-form"
import { toast } from "@workspace/ui/components/toast"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"
import { authClient } from "@/lib/auth-client"

const MIN_PASSWORD_LENGTH = 12

export function ChangePasswordForm() {
  const [error, setError] = useState<string | null>(null)

  const form = useForm({
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
    onSubmit: async ({ value, formApi }) => {
      setError(null)
      if (value.newPassword !== value.confirmPassword) {
        setError("New password and confirmation don't match.")
        return
      }
      const { error: changeError } = await authClient.changePassword({
        currentPassword: value.currentPassword,
        newPassword: value.newPassword,
        revokeOtherSessions: true,
      })
      if (changeError) {
        setError(changeError.message ?? "Could not change password.")
        return
      }
      toast.add({
        title: "Password changed",
        description: "Other sessions signed out.",
      })
      formApi.reset()
    },
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <FieldGroup>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form.Field name="currentPassword">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>Current password</FieldLabel>
              <Input
                id={field.name}
                type="password"
                autoComplete="current-password"
                required
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field
          name="newPassword"
          validators={{
            onChange: ({ value }) =>
              value.length > 0 && value.length < MIN_PASSWORD_LENGTH
                ? `Must be at least ${MIN_PASSWORD_LENGTH} characters.`
                : undefined,
          }}
        >
          {(field) => (
            <Field data-invalid={field.state.meta.errors.length > 0}>
              <FieldLabel htmlFor={field.name}>New password</FieldLabel>
              <Input
                id={field.name}
                type="password"
                autoComplete="new-password"
                required
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldDescription>
                {field.state.meta.errors.length > 0
                  ? field.state.meta.errors.join(", ")
                  : `At least ${MIN_PASSWORD_LENGTH} characters.`}
              </FieldDescription>
            </Field>
          )}
        </form.Field>

        <form.Field name="confirmPassword">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>Confirm new password</FieldLabel>
              <Input
                id={field.name}
                type="password"
                autoComplete="new-password"
                required
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" className="self-end" disabled={isSubmitting}>
              {isSubmitting ? <Spinner /> : "Change password"}
            </Button>
          )}
        </form.Subscribe>
      </FieldGroup>
    </form>
  )
}
