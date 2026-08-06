import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"
import { useState } from "react"
import { useIgnoreFinding } from "../api"

interface IgnoreFindingDialogProps {
  projectId: string
  findingId: string
  packageName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Reason (required) + optional "ignore until" date, posted via `useIgnoreFinding`. */
export function IgnoreFindingDialog({
  projectId,
  findingId,
  packageName,
  open,
  onOpenChange,
}: IgnoreFindingDialogProps) {
  const [reason, setReason] = useState("")
  const [until, setUntil] = useState("")
  const ignoreFinding = useIgnoreFinding(projectId)

  const close = (next: boolean) => {
    if (ignoreFinding.isPending) return
    onOpenChange(next)
    if (!next) {
      setReason("")
      setUntil("")
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (reason.trim() === "") return
    await ignoreFinding.mutateAsync({
      findingId,
      reason,
      ignoreUntil: until === "" ? undefined : new Date(until).toISOString(),
    })
    close(false)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>Ignore finding</DialogTitle>
            <DialogDescription>
              Mute this finding for{" "}
              <span className="font-heading">{packageName}</span> until you
              resolve or revisit it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <Field>
              <FieldLabel htmlFor="ignore-reason">Reason</FieldLabel>
              <Textarea
                id="ignore-reason"
                required
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this safe to ignore?"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ignore-until">
                Ignore until (optional)
              </FieldLabel>
              <Input
                id="ignore-until"
                type="date"
                value={until}
                onChange={(event) => setUntil(event.target.value)}
              />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={reason.trim() === "" || ignoreFinding.isPending}
            >
              {ignoreFinding.isPending ? <Spinner /> : null}
              Ignore
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
