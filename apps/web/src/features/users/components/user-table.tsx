import { useQuery } from "@tanstack/react-query"
import { Users } from "lucide-react"
import { useState } from "react"
import { DataTable } from "@/components/data-table/data-table"
import { EmptyState } from "@/components/states/empty-state"
import { QueryBoundary } from "@/components/states/query-boundary"
import { useSession } from "@/features/auth/use-permissions"
import type { UserListItem } from "../api"
import { usersQueryOptions } from "../api"
import { asRole, buildUserColumns } from "../columns"
import { BanDialog } from "./ban-dialog"

/** Client-side table (better-auth's admin list caps at 100, no server pagination needed here). */
export function UserTable() {
  const query = useQuery(usersQueryOptions())
  const session = useSession()
  const [banTarget, setBanTarget] = useState<UserListItem | null>(null)

  return (
    <>
      <QueryBoundary
        query={query}
        empty={(data) => data.users.length === 0}
        emptyState={<EmptyState icon={Users} title="No users to show" />}
      >
        {(data) => {
          const adminCount = data.users.filter(
            (user) => asRole(user.role) === "admin"
          ).length
          return (
            <DataTable
              columns={buildUserColumns({
                currentUserId: session.data?.user.id ?? "",
                adminCount,
                onBan: setBanTarget,
              })}
              data={data.users}
              getRowId={(row) => row.id}
            />
          )
        }}
      </QueryBoundary>

      <BanDialog
        open={banTarget !== null}
        onOpenChange={(open) => {
          if (!open) setBanTarget(null)
        }}
        userId={banTarget?.id ?? ""}
        userName={banTarget?.name ?? ""}
      />
    </>
  )
}
