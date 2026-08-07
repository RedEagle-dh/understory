import { createFileRoute, Outlet } from "@tanstack/react-router"
import { PageHeader } from "@/components/states/page-header"

export const Route = createFileRoute("/_authed/settings")({
  staticData: { crumb: "Settings" },
  component: SettingsLayout,
})

// Section navigation lives in the sidebar's Settings group — no second
// nav level here.
function SettingsLayout() {
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Manage your account and, if you're an admin, the whole team."
      />
      <div className="min-w-0 max-w-4xl">
        <Outlet />
      </div>
    </div>
  )
}
