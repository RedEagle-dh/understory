import { createFileRoute, redirect } from "@tanstack/react-router"
import { PageHeader } from "@/components/states/page-header"
import { ChannelList } from "@/features/notifications/components/channel-list"
import { DeliveriesSection } from "@/features/notifications/components/deliveries-section"
import { RuleList } from "@/features/notifications/components/rule-list"

export const Route = createFileRoute("/_authed/settings/notifications")({
  staticData: { crumb: "Notifications" },
  beforeLoad: ({ context }) => {
    if (!context.can.has("manageNotifications")) throw redirect({ to: "/" })
  },
  head: () => ({ meta: [{ title: "Notifications · understory" }] }),
  component: NotificationSettings,
})

function NotificationSettings() {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Discord and email channels, and which events they get notified about."
      />
      <div className="space-y-8">
        <ChannelList />
        <RuleList />
        <DeliveriesSection />
      </div>
    </>
  )
}
