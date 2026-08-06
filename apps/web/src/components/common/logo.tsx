import { cn } from "@workspace/ui/lib/utils"

/**
 * The understory mark: a tree drawn as three separated strata — canopy,
 * midstory, understory — brightest at the top, deepest green at the base.
 * The layer the product is named for is the widest and darkest: the part of
 * the tree you don't usually look at. Fixed emerald fills so the mark reads
 * identically on any background; rounded joins come from same-color strokes.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("size-5 shrink-0", className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="28.75" y="48" width="6.5" height="14" rx="1.75" fill="#065f46" />
      <path
        d="M32 5 L44 21.5 H20 Z"
        fill="#34d399"
        stroke="#34d399"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M25.5 25 H38.5 L48 39.5 H16 Z"
        fill="#10b981"
        stroke="#10b981"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M20.5 43 H43.5 L54 57.5 H10 Z"
        fill="#047857"
        stroke="#047857"
        strokeWidth="4"
        strokeLinejoin="round"
      />
    </svg>
  )
}
