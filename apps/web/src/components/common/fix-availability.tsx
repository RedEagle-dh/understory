import { cn } from "@workspace/ui/lib/utils"

type FixType = "patch" | "minor" | "major" | "none" | null

const BUMP_CLASS: Record<"major" | "minor" | "patch", string> = {
  major: "text-severity-high",
  minor: "text-severity-moderate",
  patch: "text-severity-low",
}

interface FixAvailabilityProps {
  fixedIn: string | null
  fixType: FixType
  /** Omitted (eg. scan diff rows) reads the same as `true` — assume in-range. */
  fixWithinRange?: boolean | null
  className?: string
}

/**
 * "fix in {version}" in green-ish mono when the fix lands inside the
 * declared range (`npm install` alone resolves it) — colored by bump kind,
 * VersionDelta-style, when it doesn't (a manual version-bump PR is needed).
 * No fix at all renders a muted "no fix available".
 */
export function FixAvailability({
  fixedIn,
  fixType,
  fixWithinRange,
  className,
}: FixAvailabilityProps) {
  if (fixedIn === null) {
    return (
      <span className={cn("text-muted-foreground text-xs", className)}>
        no fix available
      </span>
    )
  }

  const outOfRange = fixWithinRange === false
  const colorClass =
    outOfRange && fixType !== null && fixType !== "none"
      ? BUMP_CLASS[fixType]
      : "text-severity-low"

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", className)}>
      <span className={cn("font-heading", colorClass)}>fix in {fixedIn}</span>
      {fixWithinRange === true && (
        <span className="text-muted-foreground">within range</span>
      )}
    </span>
  )
}
