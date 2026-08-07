import { createFileRoute, redirect } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { UserPlus } from "lucide-react"
import { useState } from "react"
import { PageHeader } from "@/components/states/page-header"
import { CreateUserDialog } from "@/features/users/components/create-user-dialog"
import { UserTable } from "@/features/users/components/user-table"

export const Route = createFileRoute("/_authed/settings/users")({
  staticData: { crumb: "Users" },
  beforeLoad: ({ context }) => {
    if (!context.can.has("manageUsers")) throw redirect({ to: "/" })
  },
  head: () => ({ meta: [{ title: "Users · understory" }] }),
  component: UserManagement,
})

function UserManagement() {
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone with access, and their role: viewer, maintainer, or admin."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus />
            Add user
          </Button>
        }
      />
      <UserTable />
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  )
}
