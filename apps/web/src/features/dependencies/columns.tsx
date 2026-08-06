import type { ColumnDef } from "@tanstack/react-table"
import { Badge } from "@workspace/ui/components/badge"
import { Checkbox } from "@workspace/ui/components/checkbox"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { CopyButton } from "@/components/common/copy-button"
import { DepTypeBadge } from "@/components/common/dep-type-badge"
import { SeverityBadge } from "@/components/common/severity-badge"
import { VersionDelta } from "@/components/common/version-delta"
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header"
import type { DepType, UpdateKind } from "./api"

export interface DependencyRow {
  name: string
  version: string
  workspace: string
  depType: DepType
  isDirect: boolean
  depth: number
  declaredRange: string | null
  currentVersion: string
  wantedVersion: string | null
  latestVersion: string | null
  updateKind: UpdateKind
  deprecated: boolean
  maxSeverity: "low" | "moderate" | "high" | "critical" | null
  openFindings: number
}

/**
 * `id` on the sortable columns ("name" / "severity" / "updateKind") matches
 * the API's `sort` query values exactly — `useTableSearchParams` reads
 * `column.id` straight into the search param, no translation table needed.
 */
export const dependencyColumns: ColumnDef<DependencyRow>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={
          table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()
        }
        onCheckedChange={(checked) => table.toggleAllPageRowsSelected(checked)}
        onClick={(event) => event.stopPropagation()}
        aria-label="Select all rows on this page"
      />
    ),
    enableSorting: false,
    meta: { className: "w-10" },
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(checked) => row.toggleSelected(checked)}
        onClick={(event) => event.stopPropagation()}
        aria-label={`Select ${row.original.name}`}
      />
    ),
  },
  {
    id: "name",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Package" />
    ),
    enableSorting: true,
    meta: { mono: true, className: "min-w-48" },
    cell: ({ row }) => (
      <div className="group flex max-w-72 items-center gap-1.5">
        <span className="truncate">{row.original.name}</span>
        {row.original.deprecated && (
          <Badge variant="destructive" className="shrink-0 font-sans">
            deprecated
          </Badge>
        )}
        <CopyButton value={row.original.name} label="Copy package name" />
      </div>
    ),
  },
  {
    id: "currentVersion",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Current" />
    ),
    enableSorting: false,
    meta: { mono: true },
    cell: ({ row }) => row.original.currentVersion,
  },
  {
    id: "updateKind",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Update" />
    ),
    enableSorting: true,
    meta: { mono: true },
    cell: ({ row }) => (
      <VersionDelta
        current={row.original.currentVersion}
        target={row.original.latestVersion}
        updateKind={row.original.updateKind}
      />
    ),
  },
  {
    id: "depType",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Type" />
    ),
    enableSorting: false,
    cell: ({ row }) => <DepTypeBadge depType={row.original.depType} />,
  },
  {
    id: "origin",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Origin" />
    ),
    enableSorting: false,
    cell: ({ row }) => (
      <Tooltip>
        <TooltipTrigger
          render={<span className="text-xs text-muted-foreground" />}
        >
          {row.original.isDirect ? "direct" : "transitive"}
        </TooltipTrigger>
        <TooltipContent>depth {row.original.depth}</TooltipContent>
      </Tooltip>
    ),
  },
  {
    id: "severity",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Severity" />
    ),
    enableSorting: true,
    cell: ({ row }) => (
      <SeverityBadge
        severity={row.original.maxSeverity}
        count={row.original.openFindings}
      />
    ),
  },
]
