import type { ColumnDef } from "@tanstack/react-table"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { Ban as BanIcon } from "lucide-react"
import { RelativeTime } from "@/components/common/relative-time"
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header"
import type { Role } from "@/lib/permissions"
import type { UserListItem } from "./api"
import { useUnbanUser } from "./api"
import { RoleSelect } from "./components/role-select"

/** better-auth's `role` is an unconstrained string; narrow it to the app's own role set. */
export function asRole(role: string | null | undefined): Role {
  return role === "admin" || role === "maintainer" ? role : "viewer"
}

function UnbanCell({ userId }: { userId: string }) {
  const unbanUser = useUnbanUser()
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={unbanUser.isPending}
      onClick={() => unbanUser.mutate(userId)}
    >
      {unbanUser.isPending ? <Spinner /> : "Unban"}
    </Button>
  )
}

interface UserColumnsOptions {
  currentUserId: string
  adminCount: number
  onBan: (user: UserListItem) => void
}

/** Column defs take the fleet-wide admin count so "last admin" guards stay in sync as roles change. */
export function buildUserColumns({
  currentUserId,
  adminCount,
  onBan,
}: UserColumnsOptions): ColumnDef<UserListItem>[] {
  return [
    {
      id: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Name" />
      ),
      enableSorting: false,
      cell: ({ row }) => row.original.name,
    },
    {
      id: "email",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Email" />
      ),
      enableSorting: false,
      meta: { mono: true },
      cell: ({ row }) => row.original.email,
    },
    {
      id: "role",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Role" />
      ),
      enableSorting: false,
      cell: ({ row }) => {
        const user = row.original
        const role = asRole(user.role)
        const isSelf = user.id === currentUserId
        const isLastAdmin = role === "admin" && adminCount <= 1
        return (
          <RoleSelect
            userId={user.id}
            role={role}
            disabled={isSelf || isLastAdmin}
            disabledReason={
              isSelf
                ? "You can't change your own role"
                : isLastAdmin
                  ? "The last administrator can't be demoted"
                  : undefined
            }
          />
        )
      },
    },
    {
      id: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      enableSorting: false,
      cell: ({ row }) => {
        const user = row.original
        if (user.banned !== true) return <Badge variant="success">active</Badge>
        const badge = <Badge variant="destructive">banned</Badge>
        if (user.banReason === null || user.banReason === undefined)
          return badge
        return (
          <Tooltip>
            <TooltipTrigger
              render={<span className="inline-flex cursor-default" />}
            >
              {badge}
            </TooltipTrigger>
            <TooltipContent>{user.banReason}</TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: "created",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Created" />
      ),
      enableSorting: false,
      cell: ({ row }) => (
        <RelativeTime date={row.original.createdAt} className="text-sm" />
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { className: "w-28" },
      cell: ({ row }) => {
        const user = row.original
        const role = asRole(user.role)
        const isSelf = user.id === currentUserId
        const isLastAdmin = role === "admin" && adminCount <= 1
        const disabled = isSelf || isLastAdmin

        if (user.banned === true) {
          return (
            <div className="flex justify-end">
              <UnbanCell userId={user.id} />
            </div>
          )
        }

        if (disabled) {
          return (
            <div className="flex justify-end">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="pointer-events-auto inline-flex cursor-not-allowed [&>*]:pointer-events-none" />
                  }
                >
                  <Button type="button" variant="outline" size="sm" disabled>
                    <BanIcon />
                    Ban
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isSelf
                    ? "You can't ban yourself"
                    : "The last administrator can't be banned"}
                </TooltipContent>
              </Tooltip>
            </div>
          )
        }

        return (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onBan(user)}
            >
              <BanIcon />
              Ban
            </Button>
          </div>
        )
      },
    },
  ]
}
