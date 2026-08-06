import { cn } from "@workspace/ui/lib/utils"

type UpdateKind = "none" | "patch" | "minor" | "major"

const TARGET_CLASS: Record<Exclude<UpdateKind, "none">, string> = {
  major: "text-severity-high",
  minor: "text-severity-moderate",
  patch: "text-muted-foreground",
}

interface VersionDeltaProps {
  current: string
  target: string | null
  updateKind: UpdateKind
  className?: string
}

/**
 * `current → latest` in mono, the target segment colored by bump kind
 * (DESIGN.md: major=severity-high, minor=severity-moderate,
 * patch=muted-foreground). Renders nothing when there's no update.
 */
export function VersionDelta({
  current,
  target,
  updateKind,
  className,
}: VersionDeltaProps) {
  if (updateKind === "none" || target === null) return null

  return (
    <span className={cn("whitespace-nowrap font-heading text-xs", className)}>
      <span className="text-muted-foreground">{current}</span>
      <span className="mx-1 text-muted-foreground">→</span>
      <span className={TARGET_CLASS[updateKind]}>{target}</span>
    </span>
  )
}
