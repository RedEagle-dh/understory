import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Bell, Plus } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { RoleGate } from "@/components/common/role-gate"
import { EmptyState } from "@/components/states/empty-state"
import { QueryBoundary } from "@/components/states/query-boundary"
import { channelsQueryOptions } from "../api"
import { AddChannelDialog } from "./add-channel-dialog"
import { ChannelCard } from "./channel-card"

export function ChannelList() {
  const query = useQuery(channelsQueryOptions())
  const [addOpen, setAddOpen] = useState(false)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-base font-medium">Channels</h2>
        <RoleGate capability="manageNotifications">
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus />
            Add channel
          </Button>
        </RoleGate>
      </div>

      <QueryBoundary
        query={query}
        empty={(data) => data.items.length === 0}
        emptyState={
          <EmptyState
            icon={Bell}
            title="No notification channels configured"
            description="Connect Discord or Resend email to start receiving scan and PR notifications."
            action={
              <RoleGate capability="manageNotifications">
                <Button onClick={() => setAddOpen(true)}>Add channel</Button>
              </RoleGate>
            }
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            {data.items.map((channel) => (
              <ChannelCard key={channel.id} channel={channel} />
            ))}
          </div>
        )}
      </QueryBoundary>

      <AddChannelDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}
