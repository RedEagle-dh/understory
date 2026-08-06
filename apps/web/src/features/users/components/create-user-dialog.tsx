import { useEffect, useState } from "react"
import { Dices } from "lucide-react"
import { toast } from "@workspace/ui/components/toast"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@workspace/ui/components/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { ApiError } from "@/lib/api-error"
import type { Role } from "@/lib/permissions"
import { useCreateUser } from "../api"

const CHARSET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*"

function generatePassword(length = 16): string {
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => CHARSET[value % CHARSET.length]).join("")
}

interface CreateUserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const EMPTY_STATE = {
  name: "",
  email: "",
  password: "",
  role: "viewer" as Role,
}

export function CreateUserDialog({
  open,
  onOpenChange,
}: CreateUserDialogProps) {
  const createUser = useCreateUser()
  const [state, setState] = useState(EMPTY_STATE)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setState(EMPTY_STATE)
      setError(null)
    }
  }, [open])

  const canSubmit =
    state.name.trim() !== "" &&
    state.email.trim() !== "" &&
    state.password.length >= 8

  const handleSubmit = async () => {
    setError(null)
    try {
      await createUser.mutateAsync({
        name: state.name.trim(),
        email: state.email.trim(),
        password: state.password,
        role: state.role,
      })
      toast.add({
        title: "User created",
        description:
          "Share the temporary password securely — it won't be shown again.",
      })
      onOpenChange(false)
    } catch (submitError) {
      if (submitError instanceof ApiError) {
        setError(submitError.detail)
        return
      }
      throw submitError
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            Creates an account with a temporary password you share with them
            directly.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Field>
            <FieldLabel htmlFor="new-user-name">Name</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="new-user-name"
                value={state.name}
                onChange={(event) =>
                  setState((prev) => ({ ...prev, name: event.target.value }))
                }
              />
            </InputGroup>
          </Field>

          <Field>
            <FieldLabel htmlFor="new-user-email">Email</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="new-user-email"
                type="email"
                value={state.email}
                onChange={(event) =>
                  setState((prev) => ({ ...prev, email: event.target.value }))
                }
              />
            </InputGroup>
          </Field>

          <Field>
            <FieldLabel htmlFor="new-user-password">
              Temporary password
            </FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="new-user-password"
                value={state.password}
                onChange={(event) =>
                  setState((prev) => ({
                    ...prev,
                    password: event.target.value,
                  }))
                }
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Generate password"
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      password: generatePassword(),
                    }))
                  }
                >
                  <Dices />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>At least 8 characters.</FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <FieldLabel htmlFor="new-user-role" className="flex-1">
              Role
            </FieldLabel>
            <Select
              value={state.role}
              onValueChange={(next) => {
                if (next !== null)
                  setState((prev) => ({ ...prev, role: next as Role }))
              }}
            >
              <SelectTrigger id="new-user-role" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Viewer</SelectItem>
                <SelectItem value="maintainer">Maintainer</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || createUser.isPending}
            onClick={() => void handleSubmit()}
          >
            {createUser.isPending ? <Spinner /> : "Add user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
