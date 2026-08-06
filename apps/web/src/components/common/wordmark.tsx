import { cn } from "@workspace/ui/lib/utils"
import { Logo } from "@/components/common/logo"

/**
 * The product mark: mono lowercase wordmark with a terminal cursor block.
 * The cursor pulses subtly (and holds still under reduced motion) — the one
 * piece of ambient motion in the shell.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <Logo />
      <span className="font-heading font-semibold text-sm tracking-tight">
        understory
        <span
          aria-hidden
          className="ml-0.5 inline-block h-3 w-1.5 translate-y-px animate-pulse bg-primary motion-reduce:animate-none"
        />
      </span>
    </span>
  )
}
