import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"

type DepType = "prod" | "dev" | "peer" | "optional" | "peer_optional"

const VARIANT: Record<DepType, "default" | "secondary" | "outline"> = {
  prod: "default",
  dev: "secondary",
  peer: "outline",
  peer_optional: "outline",
  optional: "outline",
}

const LABEL: Record<DepType, string> = {
  prod: "prod",
  dev: "dev",
  peer: "peer",
  peer_optional: "peer (optional)",
  optional: "optional",
}

/** prod=filled, dev=secondary, peer(/optional)=outline, optional=muted outline. */
export function DepTypeBadge({ depType }: { depType: DepType }) {
  return (
    <Badge
      variant={VARIANT[depType]}
      className={cn(
        depType === "optional" && "text-muted-foreground",
        "font-heading"
      )}
    >
      {LABEL[depType]}
    </Badge>
  )
}
