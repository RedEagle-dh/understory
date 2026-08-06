import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  type OnChangeFn,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { cn } from "@workspace/ui/lib/utils"

/**
 * Column meta extensions used across the app's tables: `mono` renders the
 * cell in the data typeface (DESIGN.md — data IS the aesthetic), `className`
 * applies extra cell/header styling (eg. fixed widths, alignment).
 */
declare module "@tanstack/react-table" {
  // biome-ignore lint/correctness/noUnusedVariables: type params required to match the augmented interface's signature
  interface ColumnMeta<TData, TValue> {
    mono?: boolean
    className?: string
  }
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  /** Total row count on the server — required for manualPagination. */
  rowCount?: number
  sorting?: SortingState
  onSortingChange?: OnChangeFn<SortingState>
  pagination?: PaginationState
  onPaginationChange?: OnChangeFn<PaginationState>
  rowSelection?: RowSelectionState
  onRowSelectionChange?: OnChangeFn<RowSelectionState>
  manualSorting?: boolean
  manualPagination?: boolean
  manualFiltering?: boolean
  getRowId?: (row: TData) => string
  onRowClick?: (row: TData) => void
}

/**
 * Generic table shell over @tanstack/react-table. Sorting/filtering/
 * pagination state is lifted to the caller via props rather than owned
 * internally — server-driven tables (eg. dependencies) bind that state to
 * route search params; a future client-only table could hold it in
 * useState instead. Either way this component stays state-agnostic.
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  rowCount,
  sorting,
  onSortingChange,
  pagination,
  onPaginationChange,
  rowSelection,
  onRowSelectionChange,
  manualSorting = false,
  manualPagination = false,
  manualFiltering = false,
  getRowId,
  onRowClick,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    rowCount,
    // Only lift state keys the caller actually controls: an explicitly
    // `undefined` key in `state` OVERRIDES the table's internal default
    // (eg. rowSelection {}), and row.getIsSelected() then crashes reading
    // `selection[rowId]` on tables that never opted into selection.
    state: {
      ...(sorting !== undefined ? { sorting } : {}),
      ...(pagination !== undefined ? { pagination } : {}),
      ...(rowSelection !== undefined ? { rowSelection } : {}),
    },
    manualSorting,
    manualPagination,
    manualFiltering,
    enableSortingRemoval: true,
    onSortingChange,
    onPaginationChange,
    onRowSelectionChange,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="hover:bg-transparent">
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={header.column.columnDef.meta?.className}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody className="text-sm">
          {table.getRowModel().rows.length > 0 ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
                onClick={
                  onRowClick ? () => onRowClick(row.original) : undefined
                }
                className={cn(onRowClick && "cursor-pointer")}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      cell.column.columnDef.meta?.mono && "font-heading",
                      cell.column.columnDef.meta?.className
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={columns.length}
                className="h-24 text-center text-muted-foreground"
              >
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
