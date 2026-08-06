import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import type { Capability } from "@/lib/permissions"
import { usePermissions } from "@/features/auth/use-permissions"

interface RoleGateProps {
  capability: Capability
  /**
   * "hide": render nothing (navigation, creation entry points).
   * "disable": render children inside a disabled wrapper with an explanatory
   * tooltip (actions attached to visible data).
   */
  mode?: "hide" | "disable"
  children: React.ReactNode
}

export function RoleGate({
  capability,
  mode = "hide",
  children,
}: RoleGateProps) {
  const permissions = usePermissions()
  if (permissions.has(capability)) return <>{children}</>
  if (mode === "hide") return null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="pointer-events-auto inline-flex cursor-not-allowed opacity-50 [&>*]:pointer-events-none" />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>Requires the maintainer role</TooltipContent>
    </Tooltip>
  )
}
