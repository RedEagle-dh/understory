import { useForm } from "@tanstack/react-form"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"
import { toast } from "@workspace/ui/components/toast"
import { useState } from "react"
import type { ProjectDetail } from "@/features/projects/api"
import { useProjectUpdate, useTestConnection } from "@/features/projects/api"
import { ApiError } from "@/lib/api-error"

type TestResult =
  | {
      ok: true
      branch: string
      manifestCount: number
      rateLimitRemaining: number | null
    }
  | { ok: false; message: string }

function TestConnectionButton({ projectId }: { projectId: string }) {
  const testConnection = useTestConnection(projectId)
  const [result, setResult] = useState<TestResult | null>(null)

  return (
    <div className="flex flex-1 flex-col gap-1.5">
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={testConnection.isPending}
        onClick={() => {
          setResult(null)
          testConnection.mutate(undefined, {
            onSuccess: (data) => {
              setResult({
                ok: true,
                branch: data.branch,
                manifestCount: data.manifestPaths.length,
                rateLimitRemaining: data.rateLimitRemaining,
              })
            },
            onError: (error) => {
              setResult({
                ok: false,
                message:
                  error instanceof ApiError
                    ? error.detail
                    : "Connection test failed.",
              })
            },
          })
        }}
      >
        {testConnection.isPending ? <Spinner /> : "Test connection"}
      </Button>
      {result !== null &&
        (result.ok ? (
          <p className="text-muted-foreground text-xs">
            Resolved <span className="font-heading">{result.branch}</span> ·{" "}
            {result.manifestCount} manifest
            {result.manifestCount === 1 ? "" : "s"}
            {result.rateLimitRemaining !== null &&
              ` · ${result.rateLimitRemaining} requests remaining`}
          </p>
        ) : (
          <p className="text-destructive text-xs">{result.message}</p>
        ))}
    </div>
  )
}

/** Display name and tracked branch, plus a read-only reachability check. */
export function RepositoryCard({ project }: { project: ProjectDetail }) {
  const updateProject = useProjectUpdate(project.id)

  const form = useForm({
    defaultValues: { name: project.name, branch: project.branch },
    onSubmit: async ({ value }) => {
      await updateProject.mutateAsync({
        name: value.name.trim(),
        branch: value.branch.trim(),
      })
      toast.add({ title: "Repository settings saved" })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Repository</CardTitle>
        <CardDescription>
          {project.owner}/{project.repo} — display name and tracked branch.
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
            <div className="grid grid-cols-2 gap-4">
              <form.Field
                name="name"
                validators={{
                  onChange: ({ value }) =>
                    value.trim() === ""
                      ? "Display name is required."
                      : undefined,
                }}
              >
                {(field) => (
                  <Field data-invalid={field.state.meta.errors.length > 0}>
                    <FieldLabel htmlFor={field.name}>Display name</FieldLabel>
                    <Input
                      id={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                    />
                  </Field>
                )}
              </form.Field>

              <form.Field name="branch">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>Branch</FieldLabel>
                    <Input
                      id={field.name}
                      placeholder="default branch"
                      value={field.state.value}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                    />
                  </Field>
                )}
              </form.Field>
            </div>

            <div className="flex items-end justify-between gap-3">
              <TestConnectionButton projectId={project.id} />
              <form.Subscribe
                selector={(state) =>
                  [state.isDirty, state.isSubmitting] as const
                }
              >
                {([isDirty, isSubmitting]) => (
                  <Button type="submit" disabled={!isDirty || isSubmitting}>
                    {isSubmitting ? <Spinner /> : "Save"}
                  </Button>
                )}
              </form.Subscribe>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
