import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import type { Role } from "@/lib/permissions"
import { useSetRole } from "../api"

const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer",
  maintainer: "Maintainer",
  admin: "Admin",
}

interface RoleSelectProps {
  userId: string
  role: Role
  disabled?: boolean
  disabledReason?: string
}

/** Inline role editor; wrapped in a tooltip-carrying disabled state for "own row" / "last admin" guards. */
export function RoleSelect({
  userId,
  role,
  disabled = false,
  disabledReason,
}: RoleSelectProps) {
  const setRole = useSetRole()

  const select = (
    <Select
      value={role}
      disabled={disabled || setRole.isPending}
      onValueChange={(next) => {
        if (next !== null && next !== role) {
          setRole.mutate({ userId, role: next as Role })
        }
      }}
    >
      <SelectTrigger size="sm" className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(ROLE_LABELS) as Role[]).map((option) => (
          <SelectItem key={option} value={option}>
            {ROLE_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  if (!disabled || disabledReason === undefined) return select

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="pointer-events-auto inline-flex cursor-not-allowed [&>*]:pointer-events-none" />
        }
      >
        {select}
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  )
}
