import type { ColumnDef } from "@tanstack/react-table"
import { ExternalLink, RefreshCw } from "lucide-react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { PrStatusBadge } from "@/components/common/pr-status-badge"
import { RelativeTime } from "@/components/common/relative-time"
import { RoleGate } from "@/components/common/role-gate"
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header"
import type { PrListItem } from "./api"
import { useSyncPr } from "./api"

function SyncCell({ projectId, prId }: { projectId: string; prId: string }) {
  const syncPr = useSyncPr(projectId)

  return (
    <RoleGate capability="createPr" mode="disable">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={syncPr.isPending}
        onClick={(event) => {
          event.stopPropagation()
          syncPr.mutate(prId)
        }}
        aria-label="Sync pull request state"
      >
        {syncPr.isPending ? <Spinner /> : <RefreshCw />}
      </Button>
    </RoleGate>
  )
}

function bumpsSummary(bumps: PrListItem["bumps"]): string {
  const names = bumps.slice(0, 2).map((bump) => bump.packageName)
  const rest = bumps.length - names.length
  return rest > 0 ? `${names.join(", ")} +${rest} more` : names.join(", ")
}

/** Column defs take `projectId` so the sync action can scope its mutation/invalidation. */
export function buildPrColumns(projectId: string): ColumnDef<PrListItem>[] {
  return [
    {
      id: "number",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="#" />
      ),
      enableSorting: false,
      meta: { mono: true, className: "w-16" },
      cell: ({ row }) =>
        row.original.number === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `#${row.original.number}`
        ),
    },
    {
      id: "title",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Title" />
      ),
      enableSorting: false,
      meta: { className: "max-w-64" },
      cell: ({ row }) => (
        <span className="block truncate">{row.original.title}</span>
      ),
    },
    {
      id: "kind",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Kind" />
      ),
      enableSorting: false,
      cell: ({ row }) => {
        const auto = row.original.kind === "auto_security"
        const badge = (
          <Badge
            variant={auto ? "secondary" : "outline"}
            className="font-heading"
          >
            {auto ? "auto" : "manual"}
          </Badge>
        )
        if (!auto) return badge
        return (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              {badge}
            </TooltipTrigger>
            <TooltipContent>
              opened automatically for a security advisory
            </TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: "bumps",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Bumps" />
      ),
      enableSorting: false,
      meta: { mono: true, className: "max-w-56" },
      cell: ({ row }) => (
        <span className="block truncate text-xs">
          {bumpsSummary(row.original.bumps)}
        </span>
      ),
    },
    {
      id: "state",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="State" />
      ),
      enableSorting: false,
      cell: ({ row }) => <PrStatusBadge state={row.original.state} />,
    },
    {
      id: "created",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Created" />
      ),
      enableSorting: false,
      cell: ({ row }) => (
        <RelativeTime date={row.original.createdAt} className="text-sm" />
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { className: "w-20" },
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          {row.original.url !== null && (
            <a
              href={row.original.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              <span className="sr-only">Open pull request on GitHub</span>
            </a>
          )}
          <SyncCell projectId={projectId} prId={row.original.id} />
        </div>
      ),
    },
  ]
}
