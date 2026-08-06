import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { formatAbsolute, formatRelative } from "@/lib/format"

interface RelativeTimeProps {
  date: Date | string | number
  className?: string
}

/** <time> rendered as relative text ("3m ago"), with the absolute timestamp on hover. */
export function RelativeTime({ date, className }: RelativeTimeProps) {
  const target = date instanceof Date ? date : new Date(date)

  return (
    <Tooltip>
      <TooltipTrigger
        render={<time dateTime={target.toISOString()} className={className} />}
      >
        {formatRelative(target)}
      </TooltipTrigger>
      <TooltipContent>{formatAbsolute(target)}</TooltipContent>
    </Tooltip>
  )
}
