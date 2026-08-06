import { createFileRoute, Link, Outlet } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
import { Bell, UserCircle, Users } from "lucide-react"
import { RoleGate } from "@/components/common/role-gate"
import { PageHeader } from "@/components/states/page-header"

export const Route = createFileRoute("/_authed/settings")({
  staticData: { crumb: "Settings" },
  component: SettingsLayout,
})

const subNavLinkClass = cn(
  "flex items-center gap-2 rounded-md px-3 py-2 font-medium text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground",
  "data-[status=active]:bg-muted data-[status=active]:text-foreground"
)

function SettingsLayout() {
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Manage your account and, if you're an admin, the whole team."
      />
      <div className="grid grid-cols-1 gap-8 md:grid-cols-[14rem_1fr]">
        <nav className="flex flex-col gap-1">
          <Link to="/settings/profile" className={subNavLinkClass}>
            <UserCircle className="size-4" />
            Profile
          </Link>
          <RoleGate capability="manageNotifications">
            <Link to="/settings/notifications" className={subNavLinkClass}>
              <Bell className="size-4" />
              Notifications
            </Link>
          </RoleGate>
          <RoleGate capability="manageUsers">
            <Link to="/settings/users" className={subNavLinkClass}>
              <Users className="size-4" />
              Users
            </Link>
          </RoleGate>
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
