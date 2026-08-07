import { createFileRoute, redirect } from "@tanstack/react-router"
import { PageHeader } from "@/components/states/page-header"
import { GlobalDefaultsCard } from "@/features/admin-settings/components/global-defaults-card"

export const Route = createFileRoute("/_authed/settings/defaults")({
  staticData: { crumb: "Defaults" },
  beforeLoad: ({ context }) => {
    if (!context.can.has("manageSettings")) throw redirect({ to: "/" })
  },
  head: () => ({ meta: [{ title: "Defaults · understory" }] }),
  component: DefaultsSettings,
})

function DefaultsSettings() {
  return (
    <>
      <PageHeader
        title="Global defaults"
        description="Instance-wide defaults that new projects inherit."
      />
      <GlobalDefaultsCard />
    </>
  )
}
