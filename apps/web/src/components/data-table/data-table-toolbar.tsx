import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { X } from "lucide-react"
import { useEffect, useState } from "react"

interface DataTableToolbarProps {
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  /** Faceted filter popovers / toggles, rendered next to the search box. */
  filters?: React.ReactNode
  activeFilterCount?: number
  onReset?: () => void
}

/** Debounced (300ms) search input + a slot for faceted filters + a reset. */
export function DataTableToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search...",
  filters,
  activeFilterCount = 0,
  onReset,
}: DataTableToolbarProps) {
  const [draft, setDraft] = useState(searchValue)

  // Keep the input in sync when the search param changes from elsewhere
  // (eg. the Reset button, or back/forward navigation).
  useEffect(() => {
    setDraft(searchValue)
  }, [searchValue])

  useEffect(() => {
    if (draft === searchValue) return
    const handle = setTimeout(() => onSearchChange(draft), 300)
    return () => clearTimeout(handle)
  }, [draft])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={searchPlaceholder}
        className="h-8 w-full max-w-56"
      />
      {filters}
      {activeFilterCount > 0 && onReset !== undefined && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          onClick={onReset}
        >
          Reset
          <X />
        </Button>
      )}
    </div>
  )
}
