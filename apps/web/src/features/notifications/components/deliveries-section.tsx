import { useQuery } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { ChevronRight, Inbox } from "lucide-react"
import { useState } from "react"
import { RelativeTime } from "@/components/common/relative-time"
import { EmptyState } from "@/components/states/empty-state"
import { QueryBoundary } from "@/components/states/query-boundary"
import type { DeliveryStatus } from "../api"
import {
  channelsQueryOptions,
  deliveriesQueryOptions,
  EVENT_TYPE_LABELS,
} from "../api"

const STATUS_VARIANT: Record<
  DeliveryStatus,
  "default" | "destructive" | "secondary" | "outline"
> = {
  sent: "default",
  failed: "destructive",
  pending: "secondary",
  skipped: "outline",
}

interface DeliveriesSectionProps {
  channelId?: string
}

/** Read-only, page-1-only glance at recent notification deliveries. */
export function DeliveriesSection({ channelId }: DeliveriesSectionProps) {
  const [open, setOpen] = useState(false)
  const channelsQuery = useQuery(channelsQueryOptions())
  const deliveriesQuery = useQuery(deliveriesQueryOptions({ channelId }))

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 font-medium text-muted-foreground text-sm hover:text-foreground">
        <ChevronRight
          className={cn("size-4 transition-transform", open && "rotate-90")}
        />
        Recent deliveries
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">
        <QueryBoundary
          query={channelsQuery}
          skeleton={<p className="text-muted-foreground text-sm">Loading…</p>}
        >
          {(channelsData) => {
            const channelById = new Map(
              channelsData.items.map((channel) => [channel.id, channel])
            )
            return (
              <QueryBoundary
                query={deliveriesQuery}
                skeleton={
                  <p className="text-muted-foreground text-sm">Loading…</p>
                }
                empty={(data) => data.items.length === 0}
                emptyState={
                  <EmptyState
                    icon={Inbox}
                    title="No deliveries yet"
                    description="Once a notification rule fires, deliveries and their status show up here."
                  />
                }
              >
                {(data) => (
                  <div className="space-y-1.5">
                    {data.items.map((delivery) => (
                      <div
                        key={delivery.id}
                        className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {delivery.title ??
                            EVENT_TYPE_LABELS[delivery.eventType]}
                        </span>
                        <span className="w-36 truncate text-muted-foreground text-xs">
                          {channelById.get(delivery.channelId)?.name ??
                            "Unknown channel"}
                        </span>
                        {delivery.error !== null ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Badge
                                  variant={STATUS_VARIANT[delivery.status]}
                                  className="cursor-default font-heading"
                                />
                              }
                            >
                              {delivery.status}
                            </TooltipTrigger>
                            <TooltipContent>{delivery.error}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Badge
                            variant={STATUS_VARIANT[delivery.status]}
                            className="font-heading"
                          >
                            {delivery.status}
                          </Badge>
                        )}
                        <RelativeTime
                          date={delivery.createdAt}
                          className="w-16 shrink-0 text-right text-muted-foreground text-xs"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </QueryBoundary>
            )
          }}
        </QueryBoundary>
      </CollapsibleContent>
    </Collapsible>
  )
}
