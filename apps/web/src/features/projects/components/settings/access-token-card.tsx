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
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import type { ProjectDetail } from "@/features/projects/api"
import {
  useDeleteProjectToken,
  useSetProjectToken,
} from "@/features/projects/api"

const MIN_TOKEN_LENGTH = 20

/**
 * Write-only credential editor: a stored token is never rendered, only its
 * last 4 characters. "Replace token" swaps in a password input; the token
 * itself never round-trips through the form once saved.
 */
export function AccessTokenCard({ project }: { project: ProjectDetail }) {
  const setToken = useSetProjectToken(project.id)
  const deleteToken = useDeleteProjectToken(project.id)
  const [replacing, setReplacing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [tokenValue, setTokenValue] = useState("")

  const showInput = !project.hasToken || replacing

  return (
    <Card>
      <CardHeader>
        <CardTitle>Access token</CardTitle>
        <CardDescription>
          A fine-grained GitHub personal access token with{" "}
          <code>contents:read</code> access, used to read this repository.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!showInput ? (
          <div className="flex items-center justify-between gap-3">
            <span className="font-heading text-muted-foreground text-sm">
              ••••{project.tokenLast4}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setReplacing(true)}>
                Replace token
              </Button>
              <Button
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
              >
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-token">
                {project.hasToken ? "New token" : "GitHub token"}
              </FieldLabel>
              <Input
                id="project-token"
                type="password"
                autoComplete="off"
                value={tokenValue}
                onChange={(event) => setTokenValue(event.target.value)}
              />
              <FieldDescription>
                Falls back to the instance default token (if configured) when
                left unset.
              </FieldDescription>
            </Field>
            <div className="flex justify-end gap-2">
              {project.hasToken && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setReplacing(false)
                    setTokenValue("")
                  }}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="button"
                disabled={
                  tokenValue.trim().length < MIN_TOKEN_LENGTH ||
                  setToken.isPending
                }
                onClick={async () => {
                  await setToken.mutateAsync(tokenValue.trim())
                  setTokenValue("")
                  setReplacing(false)
                  toast.add({ title: "Access token saved" })
                }}
              >
                {setToken.isPending ? <Spinner /> : "Save"}
              </Button>
            </div>
          </FieldGroup>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove access token"
        description="Scans will fall back to the instance default token, if one is configured."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          await deleteToken.mutateAsync()
          toast.add({ title: "Access token removed" })
        }}
      />
    </Card>
  )
}
