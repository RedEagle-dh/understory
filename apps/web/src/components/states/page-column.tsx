import { cn } from "@workspace/ui/lib/utils"

interface PageColumnProps {
  children: React.ReactNode
  className?: string
}

/**
 * Centered content column for form-heavy pages (settings, add project).
 * Wide pages (dashboard, tables) stay full-width; these get a readable
 * measure centered in the viewport instead of hugging the left edge.
 */
export function PageColumn({ children, className }: PageColumnProps) {
  return (
    <div className={cn("mx-auto w-full max-w-4xl", className)}>{children}</div>
  )
}
