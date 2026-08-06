import type { Column } from "@tanstack/react-table"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"

interface DataTableColumnHeaderProps<TData, TValue> {
  column: Column<TData, TValue>
  title: string
  className?: string
}

/**
 * Sort-toggle column header. Cycles asc → desc → unsorted like a standard
 * TanStack table. For server-driven columns where the API only exposes a
 * "sort by" field with no direction (eg. dependencies' severity/updateKind
 * sort), the caller reads `column.getIsSorted() !== false` and ignores the
 * asc/desc distinction — the toggle still gives a clear "active vs not"
 * affordance.
 */
export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <div className={cn("font-medium text-xs", className)}>{title}</div>
  }

  const sorted = column.getIsSorted()

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "-ml-2.5 h-7 gap-1 px-2.5 font-medium text-xs",
        sorted !== false && "text-foreground",
        className
      )}
      onClick={() => column.toggleSorting(sorted === "asc")}
    >
      {title}
      {sorted === "asc" ? (
        <ArrowUp className="size-3.5" />
      ) : sorted === "desc" ? (
        <ArrowDown className="size-3.5" />
      ) : (
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      )}
    </Button>
  )
}
