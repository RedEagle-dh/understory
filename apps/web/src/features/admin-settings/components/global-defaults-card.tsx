import { useForm } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { toast } from "@workspace/ui/components/toast"
import { QueryBoundary } from "@/components/states/query-boundary"
import { adminSettingsQueryOptions, useUpdateAdminSettings } from "../api"

const INTERVAL_OPTIONS = [
  { value: "15", label: "15m" },
  { value: "30", label: "30m" },
  { value: "60", label: "1h" },
  { value: "180", label: "3h" },
  { value: "360", label: "6h" },
  { value: "720", label: "12h" },
  { value: "1440", label: "24h" },
]

interface FormProps {
  defaultScanIntervalMinutes: number
  retentionScansPerProject: number
  retentionDeliveryDays: number
}

function GlobalDefaultsForm({ settings }: { settings: FormProps }) {
  const updateSettings = useUpdateAdminSettings()

  const form = useForm({
    defaultValues: {
      defaultScanIntervalMinutes: String(settings.defaultScanIntervalMinutes),
      retentionScansPerProject: String(settings.retentionScansPerProject),
      retentionDeliveryDays: String(settings.retentionDeliveryDays),
    },
    onSubmit: async ({ value }) => {
      await updateSettings.mutateAsync({
        defaultScanIntervalMinutes: Number(value.defaultScanIntervalMinutes),
        retentionScansPerProject: Number(value.retentionScansPerProject),
        retentionDeliveryDays: Number(value.retentionDeliveryDays),
      })
      toast.add({ title: "Global defaults saved" })
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
        <form.Field name="defaultScanIntervalMinutes">
          {(field) => (
            <Field orientation="horizontal">
              <FieldLabel htmlFor={field.name} className="flex-1">
                Default scan interval
                <FieldDescription>
                  Applied to new projects unless overridden.
                </FieldDescription>
              </FieldLabel>
              <Select
                value={field.state.value}
                onValueChange={(next) => {
                  if (next !== null) field.handleChange(next)
                }}
              >
                <SelectTrigger id={field.name} className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>

        <form.Field name="retentionScansPerProject">
          {(field) => (
            <Field orientation="horizontal">
              <FieldLabel htmlFor={field.name} className="flex-1">
                Scan retention
                <FieldDescription>
                  Scans kept per project (10–10,000).
                </FieldDescription>
              </FieldLabel>
              <Input
                id={field.name}
                type="number"
                min={10}
                max={10_000}
                className="w-28"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="retentionDeliveryDays">
          {(field) => (
            <Field orientation="horizontal">
              <FieldLabel htmlFor={field.name} className="flex-1">
                Delivery log retention
                <FieldDescription>
                  Days of notification delivery history kept (1–3,650).
                </FieldDescription>
              </FieldLabel>
              <Input
                id={field.name}
                type="number"
                min={1}
                max={3650}
                className="w-28"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Subscribe
          selector={(state) => [state.isDirty, state.isSubmitting] as const}
        >
          {([isDirty, isSubmitting]) => (
            <Button
              type="submit"
              className="self-end"
              disabled={!isDirty || isSubmitting}
            >
              {isSubmitting ? <Spinner /> : "Save"}
            </Button>
          )}
        </form.Subscribe>
      </FieldGroup>
    </form>
  )
}

/** Instance-wide defaults, admin only. The route guard already gates `manageSettings`. */
export function GlobalDefaultsCard() {
  const query = useQuery(adminSettingsQueryOptions())

  return (
    <Card>
      <CardHeader>
        <CardTitle>Global defaults</CardTitle>
        <CardDescription>
          Instance-wide scan cadence and retention, used when a project doesn't
          override them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary query={query}>
          {(settings) => <GlobalDefaultsForm settings={settings} />}
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
