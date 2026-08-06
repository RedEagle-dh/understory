import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

interface CopyButtonProps {
  value: string
  label?: string
  className?: string
}

/** Icon-only copy-to-clipboard button; flashes a check mark briefly on success. */
export function CopyButton({
  value,
  label = "Copy to clipboard",
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (event: React.MouseEvent) => {
    event.stopPropagation()
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn(
        "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
        className
      )}
      onClick={handleCopy}
      aria-label={label}
    >
      {copied ? <Check className="text-severity-low" /> : <Copy />}
    </Button>
  )
}
