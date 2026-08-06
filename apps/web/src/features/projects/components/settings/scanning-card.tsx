import { useForm } from "@tanstack/react-form"
import { toast } from "@workspace/ui/components/toast"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { Switch } from "@workspace/ui/components/switch"
import type { ProjectDetail } from "@/features/projects/api"
import { useProjectUpdate } from "@/features/projects/api"

const INTERVAL_OPTIONS = [
  { value: "15", label: "15m" },
  { value: "30", label: "30m" },
  { value: "60", label: "1h" },
  { value: "180", label: "3h" },
  { value: "360", label: "6h" },
  { value: "720", label: "12h" },
  { value: "1440", label: "24h" },
]

/** Scan cadence, pause toggle, and the standalone "new major" notification opt-in. */
export function ScanningCard({ project }: { project: ProjectDetail }) {
  const updateProject = useProjectUpdate(project.id)

  const form = useForm({
    defaultValues: {
      scanIntervalMinutes: String(project.scanIntervalMinutes),
      paused: project.paused,
      notifyOnNewMajor: project.notifyOnNewMajor,
    },
    onSubmit: async ({ value }) => {
      await updateProject.mutateAsync({
        scanIntervalMinutes: Number(value.scanIntervalMinutes),
        paused: value.paused,
        notifyOnNewMajor: value.notifyOnNewMajor,
      })
      toast.add({ title: "Scanning settings saved" })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scanning</CardTitle>
        <CardDescription>How often this project is scanned.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.Field name="scanIntervalMinutes">
              {(field) => (
                <Field orientation="horizontal">
                  <FieldLabel htmlFor={field.name} className="flex-1">
                    Scan interval
                    <FieldDescription>
                      How often the project is checked for updates.
                    </FieldDescription>
                  </FieldLabel>
                  <Select
                    items={Object.fromEntries(
                      INTERVAL_OPTIONS.map((option) => [
                        option.value,
                        option.label,
                      ])
                    )}
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

            <form.Field name="paused">
              {(field) => (
                <Field orientation="horizontal">
                  <FieldLabel htmlFor={field.name} className="flex-1">
                    Scanning paused
                    <FieldDescription>
                      Skip this project on the scheduled cadence.
                    </FieldDescription>
                  </FieldLabel>
                  <Switch
                    id={field.name}
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="notifyOnNewMajor">
              {(field) => (
                <Field orientation="horizontal">
                  <FieldLabel htmlFor={field.name} className="flex-1">
                    Notify on new major versions
                    <FieldDescription>
                      Send a notification when a dependency gets a new major
                      release, even without a vulnerability.
                    </FieldDescription>
                  </FieldLabel>
                  <Switch
                    id={field.name}
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
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
      </CardContent>
    </Card>
  )
}
