import { useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
  /** When set, the confirm action stays disabled until the input matches this exactly. */
  requireText?: string
  onConfirm: () => void | Promise<void>
}

/** Alert-dialog-based confirmation with an optional type-to-confirm guard and a loading state. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive = false,
  requireText,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("")
  const [pending, setPending] = useState(false)

  const textMismatch = requireText !== undefined && typed !== requireText
  const disabled = pending || textMismatch

  const close = (next: boolean) => {
    if (pending) return
    onOpenChange(next)
    if (!next) setTyped("")
  }

  const handleConfirm = async () => {
    setPending(true)
    try {
      await onConfirm()
      close(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description !== undefined && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {requireText !== undefined && (
          <Input
            autoFocus
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={requireText}
            aria-label={`Type "${requireText}" to confirm`}
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={disabled}
            onClick={() => void handleConfirm()}
          >
            {pending ? <Spinner /> : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
