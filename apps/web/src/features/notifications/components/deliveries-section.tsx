import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
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
import { RelativeTime } from "@/components/common/relative-time"
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
      <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight
          className={cn("size-4 transition-transform", open && "rotate-90")}
        />
        Recent deliveries
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">
        <QueryBoundary
          query={channelsQuery}
          skeleton={<p className="text-sm text-muted-foreground">Loading…</p>}
        >
          {(channelsData) => {
            const channelById = new Map(
              channelsData.items.map((channel) => [channel.id, channel])
            )
            return (
              <QueryBoundary
                query={deliveriesQuery}
                skeleton={
                  <p className="text-sm text-muted-foreground">Loading…</p>
                }
                empty={(data) => data.items.length === 0}
                emptyState={
                  <p className="text-sm text-muted-foreground">
                    No deliveries yet.
                  </p>
                }
              >
                {(data) => (
                  <div className="space-y-1.5">
                    {data.items.map((delivery) => (
                      <div
                        key={delivery.id}
                        className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {delivery.title ??
                            EVENT_TYPE_LABELS[delivery.eventType]}
                        </span>
                        <span className="w-36 truncate text-xs text-muted-foreground">
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
                          className="w-16 shrink-0 text-right text-xs text-muted-foreground"
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
