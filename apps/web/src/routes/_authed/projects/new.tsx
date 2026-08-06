import { useForm } from "@tanstack/react-form"
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
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
import { Spinner } from "@workspace/ui/components/spinner"
import { toast } from "@workspace/ui/components/toast"
import { useState } from "react"
import { PageHeader } from "@/components/states/page-header"
import { useCreateProject } from "@/features/projects/api"
import { ApiError } from "@/lib/api-error"

export const Route = createFileRoute("/_authed/projects/new")({
  staticData: { crumb: "Add project" },
  beforeLoad: ({ context }) => {
    if (!context.can.has("createProject")) throw redirect({ to: "/" })
  },
  component: NewProject,
})

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

function NewProject() {
  const navigate = useNavigate()
  const createProject = useCreateProject()
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useForm({
    defaultValues: {
      owner: "",
      repo: "",
      branch: "",
      name: "",
      token: "",
    },
    onSubmit: async ({ value }) => {
      setServerError(null)
      try {
        const project = await createProject.mutateAsync({
          owner: value.owner.trim(),
          repo: value.repo.trim(),
          branch: value.branch.trim() === "" ? undefined : value.branch.trim(),
          name: value.name.trim() === "" ? undefined : value.name.trim(),
          token: value.token.trim() === "" ? undefined : value.token.trim(),
        })
        toast.add({
          title: "Project added",
          description: "First scan queued",
        })
        await navigate({
          to: "/projects/$projectId",
          params: { projectId: project.id },
        })
      } catch (error) {
        if (error instanceof ApiError && error.status === 422) {
          setServerError(error.detail)
          return
        }
        throw error
      }
    },
  })

  return (
    <>
      <PageHeader
        title="Add project"
        description="Register a GitHub repository to start auditing its dependencies."
      />
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Repository</CardTitle>
          <CardDescription>
            The repo is validated for reachability before it's registered.
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
              {serverError !== null && (
                <Alert variant="destructive">
                  <AlertDescription>{serverError}</AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-2 gap-4">
                <form.Field
                  name="owner"
                  validators={{
                    onChange: ({ value }) =>
                      value.trim() === ""
                        ? "Owner is required."
                        : !OWNER_PATTERN.test(value.trim())
                          ? "Not a valid GitHub owner/org name."
                          : undefined,
                  }}
                >
                  {(field) => (
                    <Field data-invalid={field.state.meta.errors.length > 0}>
                      <FieldLabel htmlFor={field.name}>Owner</FieldLabel>
                      <Input
                        id={field.name}
                        placeholder="expressjs"
                        required
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                      />
                      {field.state.meta.errors.length > 0 && (
                        <FieldDescription className="text-destructive">
                          {field.state.meta.errors.join(", ")}
                        </FieldDescription>
                      )}
                    </Field>
                  )}
                </form.Field>

                <form.Field
                  name="repo"
                  validators={{
                    onChange: ({ value }) =>
                      value.trim() === ""
                        ? "Repo is required."
                        : !REPO_PATTERN.test(value.trim())
                          ? "Not a valid repository name."
                          : undefined,
                  }}
                >
                  {(field) => (
                    <Field data-invalid={field.state.meta.errors.length > 0}>
                      <FieldLabel htmlFor={field.name}>Repository</FieldLabel>
                      <Input
                        id={field.name}
                        placeholder="express"
                        required
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                      />
                      {field.state.meta.errors.length > 0 && (
                        <FieldDescription className="text-destructive">
                          {field.state.meta.errors.join(", ")}
                        </FieldDescription>
                      )}
                    </Field>
                  )}
                </form.Field>
              </div>

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
                    <FieldDescription>
                      Leave blank to track the repository's default branch.
                    </FieldDescription>
                  </Field>
                )}
              </form.Field>

              <form.Field name="name">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>Display name</FieldLabel>
                    <Input
                      id={field.name}
                      placeholder="owner/repo"
                      value={field.state.value}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                    />
                    <FieldDescription>
                      Defaults to owner/repo when left blank.
                    </FieldDescription>
                  </Field>
                )}
              </form.Field>

              <form.Field name="token">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>
                      GitHub token (optional)
                    </FieldLabel>
                    <Input
                      id={field.name}
                      type="password"
                      autoComplete="off"
                      value={field.state.value}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                    />
                    <FieldDescription>
                      A fine-grained personal access token with{" "}
                      <code>contents:read</code> access, required for private
                      repos and to avoid rate limits. See{" "}
                      <a
                        href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
                        target="_blank"
                        rel="noreferrer"
                      >
                        GitHub's token setup guide
                      </a>
                      .
                    </FieldDescription>
                  </Field>
                )}
              </form.Field>

              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? <Spinner /> : "Add project"}
                  </Button>
                )}
              </form.Subscribe>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </>
  )
}
