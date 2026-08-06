import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"
import { useTriggerScan } from "@/features/projects/api"
import { RoleGate } from "./role-gate"

interface ScanNowButtonProps {
  projectId: string
  running?: boolean
  size?: "xs" | "sm" | "default"
  variant?: "default" | "outline" | "secondary" | "ghost"
}

/** RoleGated "Scan now" trigger shared by project cards and the project header. */
export function ScanNowButton({
  projectId,
  running = false,
  size = "sm",
  variant = "ghost",
}: ScanNowButtonProps) {
  const triggerScan = useTriggerScan(projectId)
  const pending = running || triggerScan.isPending

  return (
    <RoleGate capability="scan" mode="disable">
      <Button
        type="button"
        size={size}
        variant={variant}
        disabled={pending}
        onClick={(event) => {
          event.stopPropagation()
          event.preventDefault()
          triggerScan.mutate()
        }}
      >
        {pending ? <Spinner /> : null}
        {pending ? "Scanning" : "Scan now"}
      </Button>
    </RoleGate>
  )
}
