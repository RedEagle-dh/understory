import { useForm } from "@tanstack/react-form"
import { useNavigate } from "@tanstack/react-router"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"
import { toast } from "@workspace/ui/components/toast"
import { useEffect, useState } from "react"
import { ApiError } from "@/lib/api-error"
import { useAddProjectFlow } from "../add-project-context"
import { useCreateProject } from "../api"

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

/** Register-a-repository dialog; opened from anywhere via `useAddProjectFlow()`. */
export function AddProjectDialog() {
  const { open, setOpen } = useAddProjectFlow()
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
        setOpen(false)
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

  // Fresh form every time the dialog opens — a cancelled attempt must not
  // leak into the next one.
  useEffect(() => {
    if (open) {
      form.reset()
      setServerError(null)
    }
  }, [open, form])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Register a GitHub repository to start auditing its dependencies.
            The repo is validated for reachability before it's registered.
          </DialogDescription>
        </DialogHeader>
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
                    onChange={(event) => field.handleChange(event.target.value)}
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
                    onChange={(event) => field.handleChange(event.target.value)}
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
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldDescription>
                    A fine-grained personal access token, required for private
                    repos and to avoid rate limits.{" "}
                    <code>contents:read</code> is enough for scanning; opening
                    update PRs needs <code>contents</code> and{" "}
                    <code>pull requests</code> read/write. See{" "}
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
      </DialogContent>
    </Dialog>
  )
}
