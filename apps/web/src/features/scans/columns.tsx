import type { ColumnDef } from "@tanstack/react-table"
import { Badge } from "@workspace/ui/components/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { AlertTriangle } from "lucide-react"
import { CopyButton } from "@/components/common/copy-button"
import { RelativeTime } from "@/components/common/relative-time"
import { ScanStatusPill } from "@/components/common/scan-status-pill"
import { SeverityBar } from "@/components/common/severity-bar"
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header"
import type { ScanListItem } from "./api"
import { formatDuration, TRIGGER_LABEL, TRIGGER_VARIANT } from "./lib"

export const scanColumns: ColumnDef<ScanListItem>[] = [
  {
    id: "started",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Started" />
    ),
    enableSorting: false,
    cell: ({ row }) => (
      <RelativeTime date={row.original.startedAt} className="text-sm" />
    ),
  },
  {
    id: "trigger",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Trigger" />
    ),
    enableSorting: false,
    cell: ({ row }) => {
      const trigger = row.original.trigger
      const badge = (
        <Badge variant={TRIGGER_VARIANT[trigger]} className="font-heading">
          {TRIGGER_LABEL[trigger]}
        </Badge>
      )
      if (trigger !== "auto") return badge
      return (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            {badge}
          </TooltipTrigger>
          <TooltipContent>opened by auto-PR</TooltipContent>
        </Tooltip>
      )
    },
  },
  {
    id: "status",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Status" />
    ),
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <ScanStatusPill scan={row.original} />
        {row.original.warnings.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={<span className="inline-flex text-severity-moderate" />}
            >
              <AlertTriangle className="size-3.5" aria-label="Scan warnings" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <ul className="list-disc space-y-1 pl-3">
                {row.original.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    ),
  },
  {
    id: "duration",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Duration" />
    ),
    enableSorting: false,
    meta: { mono: true },
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <span>{formatDuration(row.original.durationMs)}</span>
        {row.original.depsReused && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  variant="outline"
                  className="font-sans text-[10px] text-muted-foreground"
                />
              }
            >
              cached
            </TooltipTrigger>
            <TooltipContent>
              dependency set reused — lockfile unchanged
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    ),
  },
  {
    id: "deps",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Deps" />
    ),
    enableSorting: false,
    meta: { mono: true },
    cell: ({ row }) => row.original.totalDeps ?? "—",
  },
  {
    id: "vulnerabilities",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Vulnerabilities" />
    ),
    enableSorting: false,
    meta: { className: "min-w-32" },
    cell: ({ row }) => (
      <SeverityBar
        counts={{
          critical: row.original.vulnCritical ?? 0,
          high: row.original.vulnHigh ?? 0,
          moderate: row.original.vulnModerate ?? 0,
          low: row.original.vulnLow ?? 0,
        }}
      />
    ),
  },
  {
    id: "delta",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Δ findings" />
    ),
    enableSorting: false,
    meta: { mono: true },
    cell: ({ row }) => {
      const newFindings = row.original.newFindings ?? 0
      const resolvedFindings = row.original.resolvedFindings ?? 0
      return (
        <span className="whitespace-nowrap text-xs">
          <span
            className={cn(
              newFindings > 0 ? "text-severity-high" : "text-muted-foreground"
            )}
          >
            +{newFindings}
          </span>
          <span className="text-muted-foreground"> −{resolvedFindings}</span>
        </span>
      )
    },
  },
  {
    id: "commit",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Commit" />
    ),
    enableSorting: false,
    meta: { mono: true },
    cell: ({ row }) => {
      const sha = row.original.commitSha
      if (sha === null) {
        return <span className="text-muted-foreground text-xs">—</span>
      }
      return (
        <div className="group flex items-center gap-1">
          <span className="text-xs">{sha.slice(0, 7)}</span>
          <CopyButton value={sha} label="Copy commit sha" />
        </div>
      )
    },
  },
]
