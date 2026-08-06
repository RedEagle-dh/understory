import { cn } from "@workspace/ui/lib/utils"

/**
 * The app's signature accent: a hairline strip of the five severity colors,
 * critical → info. It is the product's domain rendered as a device — used
 * sparingly (auth card, project cards), never as decoration on ordinary
 * surfaces.
 */
export function SeveritySpectrum({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("flex h-0.5 w-full overflow-hidden rounded-full", className)}
    >
      <span className="flex-1 bg-severity-critical" />
      <span className="flex-1 bg-severity-high" />
      <span className="flex-1 bg-severity-moderate" />
      <span className="flex-1 bg-severity-low" />
      <span className="flex-1 bg-severity-info" />
    </div>
  )
}
