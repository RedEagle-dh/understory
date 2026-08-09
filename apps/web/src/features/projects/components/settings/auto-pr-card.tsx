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
import { SeverityBadge } from "@/components/common/severity-badge"
import type { ProjectDetail } from "@/features/projects/api"
import { useProjectUpdate } from "@/features/projects/api"

const SEVERITY_OPTIONS = ["low", "moderate", "high", "critical"] as const
const BUMP_OPTIONS = [
  { value: "patch", label: "Patch only" },
  { value: "minor", label: "Up to minor" },
  { value: "major", label: "Up to major" },
] as const

function toLabelsArray(input: string): string[] | null {
  const labels = input
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "")
  return labels.length === 0 ? null : labels
}

/** Auto-PR opt-in and its dependent fields, shown only once the toggle is on. */
export function AutoPrCard({ project }: { project: ProjectDetail }) {
  const updateProject = useProjectUpdate(project.id)

  const form = useForm({
    defaultValues: {
      autoPrEnabled: project.autoPrEnabled,
      autoPrMinSeverity: project.autoPrMinSeverity,
      autoPrMaxBump: project.autoPrMaxBump,
      autoPrKevOverride: project.autoPrKevOverride,
      regenerateLockfile: project.regenerateLockfile,
      prBaseBranch: project.prBaseBranch ?? "",
      prLabels: (project.prLabels ?? []).join(", "),
    },
    onSubmit: async ({ value }) => {
      await updateProject.mutateAsync({
        autoPrEnabled: value.autoPrEnabled,
        autoPrMinSeverity: value.autoPrMinSeverity,
        autoPrMaxBump: value.autoPrMaxBump,
        autoPrKevOverride: value.autoPrKevOverride,
        regenerateLockfile: value.regenerateLockfile,
        prBaseBranch:
          value.prBaseBranch.trim() === "" ? null : value.prBaseBranch.trim(),
        prLabels: toLabelsArray(value.prLabels),
      })
      toast.add({ title: "Automatic pull request settings saved" })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automatic pull requests</CardTitle>
        <CardDescription>
          Open pull requests automatically when a scan finds a fix.
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
            <form.Field name="autoPrEnabled">
              {(field) => (
                <Field orientation="horizontal">
                  <FieldLabel htmlFor={field.name} className="flex-1">
                    Open pull requests automatically
                    <FieldDescription>
                      A scan that finds an eligible fix opens a PR without
                      manual review.
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

            <form.Subscribe selector={(state) => state.values.autoPrEnabled}>
              {(enabled) =>
                enabled && (
                  <>
                    <form.Field name="autoPrMinSeverity">
                      {(field) => (
                        <Field orientation="horizontal">
                          <FieldLabel htmlFor={field.name} className="flex-1">
                            Minimum severity
                            <FieldDescription>
                              Only vulnerabilities at or above this severity
                              trigger a PR.
                            </FieldDescription>
                          </FieldLabel>
                          <Select
                            items={Object.fromEntries(
                              SEVERITY_OPTIONS.map((severity) => [
                                severity,
                                <SeverityBadge
                                  key={severity}
                                  severity={severity}
                                />,
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
                              {SEVERITY_OPTIONS.map((severity) => (
                                <SelectItem key={severity} value={severity}>
                                  <SeverityBadge severity={severity} />
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      )}
                    </form.Field>

                    <form.Field name="autoPrMaxBump">
                      {(field) => (
                        <Field orientation="horizontal">
                          <FieldLabel htmlFor={field.name} className="flex-1">
                            Maximum version bump
                            <FieldDescription>
                              The largest semver bump auto-PRs are allowed to
                              make.
                            </FieldDescription>
                          </FieldLabel>
                          <Select
                            items={Object.fromEntries(
                              BUMP_OPTIONS.map((option) => [
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
                              {BUMP_OPTIONS.map((option) => (
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

                    <form.Field name="autoPrKevOverride">
                      {(field) => (
                        <Field orientation="horizontal">
                          <FieldLabel htmlFor={field.name} className="flex-1">
                            Always fix exploited vulnerabilities
                            <FieldDescription>
                              Ignore the severity threshold when CISA lists the
                              CVE as exploited in the wild. The maximum version
                              bump still applies.
                            </FieldDescription>
                          </FieldLabel>
                          <Switch
                            id={field.name}
                            checked={field.state.value}
                            onCheckedChange={(checked) =>
                              field.handleChange(checked)
                            }
                          />
                        </Field>
                      )}
                    </form.Field>

                    <form.Field name="regenerateLockfile">
                      {(field) => (
                        <Field orientation="horizontal">
                          <FieldLabel htmlFor={field.name} className="flex-1">
                            Regenerate lockfile
                            <FieldDescription>
                              Reinstall and commit an updated lockfile instead
                              of editing versions only.
                            </FieldDescription>
                          </FieldLabel>
                          <Switch
                            id={field.name}
                            checked={field.state.value}
                            onCheckedChange={(checked) =>
                              field.handleChange(checked)
                            }
                          />
                        </Field>
                      )}
                    </form.Field>

                    <form.Field name="prBaseBranch">
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor={field.name}>
                            Base branch
                          </FieldLabel>
                          <Input
                            id={field.name}
                            placeholder={
                              project.branch === ""
                                ? "default branch"
                                : project.branch
                            }
                            value={field.state.value}
                            onChange={(event) =>
                              field.handleChange(event.target.value)
                            }
                          />
                          <FieldDescription>
                            Defaults to the tracked branch when left blank.
                          </FieldDescription>
                        </Field>
                      )}
                    </form.Field>

                    <form.Field name="prLabels">
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor={field.name}>Labels</FieldLabel>
                          <Input
                            id={field.name}
                            placeholder="dependencies, automated"
                            value={field.state.value}
                            onChange={(event) =>
                              field.handleChange(event.target.value)
                            }
                          />
                          <FieldDescription>
                            Comma-separated labels applied to every automatic
                            pull request.
                          </FieldDescription>
                        </Field>
                      )}
                    </form.Field>
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
