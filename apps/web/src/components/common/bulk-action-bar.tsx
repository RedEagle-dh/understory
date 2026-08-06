import { Button } from "@workspace/ui/components/button"
import { RoleGate } from "./role-gate"

interface BulkActionBarProps {
  count: number
  onCreatePr: () => void
  onClear: () => void
}

/** Floating "N selected · Create PR · Clear" bar for table row-selection bulk actions. */
export function BulkActionBar({
  count,
  onCreatePr,
  onClear,
}: BulkActionBarProps) {
  if (count === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg border bg-popover px-4 py-2.5 text-sm text-popover-foreground shadow-lg">
        <span className="font-heading text-xs text-muted-foreground">
          {count} selected
        </span>
        <span className="text-muted-foreground">·</span>
        <RoleGate capability="createPr" mode="disable">
          <Button type="button" size="sm" onClick={onCreatePr}>
            Create PR
          </Button>
        </RoleGate>
        <span className="text-muted-foreground">·</span>
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  )
}
