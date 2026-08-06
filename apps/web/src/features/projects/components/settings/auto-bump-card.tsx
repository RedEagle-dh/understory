import { useForm } from "@tanstack/react-form"
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
import { Switch } from "@workspace/ui/components/switch"
import { toast } from "@workspace/ui/components/toast"
import type { ProjectDetail } from "@/features/projects/api"
import { useProjectUpdate } from "@/features/projects/api"

const KIND_OPTIONS = [
  { value: "patch", label: "Patch only" },
  { value: "minor", label: "Up to minor" },
  { value: "major", label: "Up to major" },
] as const

function clampInt(raw: string, max: number): number {
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value) || value < 0) return 0
  return Math.min(value, max)
}

/**
 * Automatic version-bump PRs for outdated direct dependencies — distinct from
 * security auto-PRs. The release-age cooldown is the supply-chain guard: a
 * new version only qualifies once it has survived on the registry for the
 * configured time. Stored as hours; edited as days + hours.
 */
export function AutoBumpCard({ project }: { project: ProjectDetail }) {
  const updateProject = useProjectUpdate(project.id)

  const form = useForm({
    defaultValues: {
      autoBumpEnabled: project.autoBumpEnabled,
      autoBumpMaxKind: project.autoBumpMaxKind,
      cooldownDays: String(Math.floor(project.autoBumpMinReleaseAgeHours / 24)),
      cooldownHours: String(project.autoBumpMinReleaseAgeHours % 24),
    },
    onSubmit: async ({ value }) => {
      const totalHours =
        clampInt(value.cooldownDays, 365) * 24 +
        clampInt(value.cooldownHours, 23)
      await updateProject.mutateAsync({
        autoBumpEnabled: value.autoBumpEnabled,
        autoBumpMaxKind: value.autoBumpMaxKind,
        autoBumpMinReleaseAgeHours: totalHours,
      })
      toast.add({ title: "Automatic bump settings saved" })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automatic version bumps</CardTitle>
        <CardDescription>
          Open a pull request bumping outdated direct dependencies to their
          newest version — independent of vulnerabilities. One bump PR is kept
          open at a time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.Field name="autoBumpEnabled">
              {(field) => (
                <Field orientation="horizontal">
                  <FieldLabel htmlFor={field.name} className="flex-1">
                    Bump dependencies automatically
                    <FieldDescription>
                      Runs after each scan on dependencies that pass the
                      boundaries below.
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

            <form.Subscribe selector={(state) => state.values.autoBumpEnabled}>
              {(enabled) =>
                enabled && (
                  <>
                    <form.Field name="autoBumpMaxKind">
                      {(field) => (
                        <Field orientation="horizontal">
                          <FieldLabel htmlFor={field.name} className="flex-1">
                            Update kinds
                            <FieldDescription>
                              The largest version jump an automatic bump may
                              make.
                            </FieldDescription>
                          </FieldLabel>
                          <Select
                            items={Object.fromEntries(
                              KIND_OPTIONS.map((option) => [
                                option.value,
                                option.label,
                              ])
                            )}
                            value={field.state.value}
                            onValueChange={(next) => {
                              if (next !== null) field.handleChange(next)
                            }}
                          >
                            <SelectTrigger id={field.name} className="w-36">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {KIND_OPTIONS.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      )}
                    </form.Field>

                    <Field orientation="horizontal">
                      <FieldLabel className="flex-1">
                        Release-age cooldown
                        <FieldDescription>
                          A new version qualifies only after this long on the
                          registry — protection against compromised releases. 0
                          disables the wait.
                        </FieldDescription>
                      </FieldLabel>
                      <div className="flex items-center gap-2">
                        <form.Field name="cooldownDays">
                          {(field) => (
                            <div className="flex items-center gap-1.5">
                              <Input
                                id={field.name}
                                type="number"
                                min={0}
                                max={365}
                                className="w-20 font-heading"
                                value={field.state.value}
                                onChange={(event) =>
                                  field.handleChange(event.target.value)
                                }
                              />
                              <span className="text-muted-foreground text-sm">
                                days
                              </span>
                            </div>
                          )}
                        </form.Field>
                        <form.Field name="cooldownHours">
                          {(field) => (
                            <div className="flex items-center gap-1.5">
                              <Input
                                id={field.name}
                                type="number"
                                min={0}
                                max={23}
                                className="w-16 font-heading"
                                value={field.state.value}
                                onChange={(event) =>
                                  field.handleChange(event.target.value)
                                }
                              />
                              <span className="text-muted-foreground text-sm">
                                hours
                              </span>
                            </div>
                          )}
                        </form.Field>
                      </div>
                    </Field>
                  </>
                )
              }
            </form.Subscribe>

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
