import { useEffect, useState } from "react"
import { toast } from "@workspace/ui/components/toast"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"
import { useBanUser } from "../api"

interface BanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string
  userName: string
}

export function BanDialog({
  open,
  onOpenChange,
  userId,
  userName,
}: BanDialogProps) {
  const banUser = useBanUser()
  const [reason, setReason] = useState("")

  useEffect(() => {
    if (open) setReason("")
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ban {userName}</DialogTitle>
          <DialogDescription>
            They immediately lose access to the app.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="ban-reason">Reason (optional)</FieldLabel>
          <Textarea
            id="ban-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Shown to the user if they try to sign in."
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={banUser.isPending}
            onClick={async () => {
              await banUser.mutateAsync({
                userId,
                banReason: reason.trim() === "" ? undefined : reason.trim(),
              })
              toast.add({ title: `${userName} banned` })
              onOpenChange(false)
            }}
          >
            {banUser.isPending ? <Spinner /> : "Ban user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
