import { Badge } from "@workspace/ui/components/badge"
import { Spinner } from "@workspace/ui/components/spinner"
import { cn } from "@workspace/ui/lib/utils"

type PrState = "creating" | "open" | "merged" | "closed" | "failed"

const LABEL: Record<PrState, string> = {
  creating: "creating",
  open: "open",
  merged: "merged",
  closed: "closed",
  failed: "failed",
}

const VARIANT: Record<
  Exclude<PrState, "creating" | "merged">,
  "default" | "outline" | "destructive"
> = {
  open: "default",
  closed: "outline",
  failed: "destructive",
}

interface PrStatusBadgeProps {
  state: PrState
  className?: string
}

/**
 * creating = secondary + spinner, open = filled, merged = severity-low tint
 * (the app's one affirmative accent — see CopyButton's check mark), closed =
 * outline, failed = destructive.
 */
export function PrStatusBadge({ state, className }: PrStatusBadgeProps) {
  if (state === "creating") {
    return (
      <Badge
        variant="secondary"
        className={cn("gap-1 font-heading", className)}
      >
        <Spinner className="size-3" />
        {LABEL[state]}
      </Badge>
    )
  }

  if (state === "merged") {
    return (
      <Badge
        variant="outline"
        className={cn(
          "border-severity-low/40 font-heading text-severity-low",
          className
        )}
      >
        {LABEL[state]}
      </Badge>
    )
  }

  return (
    <Badge variant={VARIANT[state]} className={cn("font-heading", className)}>
      {LABEL[state]}
    </Badge>
  )
}
