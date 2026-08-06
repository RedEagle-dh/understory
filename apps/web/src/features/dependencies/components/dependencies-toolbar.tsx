import { Toggle } from "@workspace/ui/components/toggle"
import { DataTableFacetedFilter } from "@/components/data-table/data-table-faceted-filter"
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar"
import type { DepType, UpdateKind } from "../api"

/** Matches the dependencies route's search schema field names exactly. */
export interface DependenciesFilterPatch {
  q?: string
  type?: DepType
  updateKind?: UpdateKind
  direct?: boolean
  hasVuln?: boolean
}

const DEP_TYPE_OPTIONS = [
  { label: "prod", value: "prod" },
  { label: "dev", value: "dev" },
  { label: "peer", value: "peer" },
  { label: "peer (optional)", value: "peer_optional" },
  { label: "optional", value: "optional" },
]

const UPDATE_KIND_OPTIONS = [
  { label: "major", value: "major" },
  { label: "minor", value: "minor" },
  { label: "patch", value: "patch" },
  { label: "none", value: "none" },
]

interface DependenciesToolbarProps {
  q: string
  depType?: DepType
  updateKind?: UpdateKind
  direct?: boolean
  hasVuln?: boolean
  onChange: (patch: DependenciesFilterPatch) => void
  onReset: () => void
}

/**
 * Search + faceted filters for the dependencies table. Type and update-kind
 * are single-select facets — the API only accepts one value for each — so
 * `DataTableFacetedFilter` is used with `multiple={false}`.
 */
export function DependenciesToolbar({
  q,
  depType,
  updateKind,
  direct,
  hasVuln,
  onChange,
  onReset,
}: DependenciesToolbarProps) {
  const activeFilterCount =
    (depType !== undefined ? 1 : 0) +
    (updateKind !== undefined ? 1 : 0) +
    (direct === true ? 1 : 0) +
    (hasVuln === true ? 1 : 0) +
    (q !== "" ? 1 : 0)

  return (
    <DataTableToolbar
      searchValue={q}
      onSearchChange={(value) =>
        onChange({ q: value === "" ? undefined : value })
      }
      searchPlaceholder="Search packages..."
      activeFilterCount={activeFilterCount}
      onReset={onReset}
      filters={
        <>
          <DataTableFacetedFilter
            title="Type"
            options={DEP_TYPE_OPTIONS}
            multiple={false}
            selected={depType !== undefined ? new Set([depType]) : new Set()}
            onChange={(selected) => {
              const [value] = selected
              onChange({ type: value as DepType | undefined })
            }}
          />
          <DataTableFacetedFilter
            title="Update"
            options={UPDATE_KIND_OPTIONS}
            multiple={false}
            selected={
              updateKind !== undefined ? new Set([updateKind]) : new Set()
            }
            onChange={(selected) => {
              const [value] = selected
              onChange({ updateKind: value as UpdateKind | undefined })
            }}
          />
          <Toggle
            variant="outline"
            size="sm"
            pressed={hasVuln === true}
            onPressedChange={(pressed) =>
              onChange({ hasVuln: pressed ? true : undefined })
            }
          >
            Has vulnerabilities
          </Toggle>
          <Toggle
            variant="outline"
            size="sm"
            pressed={direct === true}
            onPressedChange={(pressed) =>
              onChange({ direct: pressed ? true : undefined })
            }
          >
            Direct only
          </Toggle>
        </>
      }
    />
  )
}
