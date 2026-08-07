import { createFileRoute, Outlet } from "@tanstack/react-router"
import { PageColumn } from "@/components/states/page-column"

export const Route = createFileRoute("/_authed/settings")({
  staticData: { crumb: "Settings" },
  component: SettingsLayout,
})

// Section navigation lives in the sidebar's Settings group, and each page
// brings its own heading — this layout only provides the centered column.
function SettingsLayout() {
  return (
    <PageColumn className="min-w-0">
      <Outlet />
    </PageColumn>
  )
}
