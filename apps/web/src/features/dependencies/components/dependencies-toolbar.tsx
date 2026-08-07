import { Toggle } from "@workspace/ui/components/toggle"
import { DataTableFacetedFilter } from "@/components/data-table/data-table-faceted-filter"
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar"
import type { DepType, UpdateKind } from "../api"

/** Matches the dependencies route's search schema field names exactly. */
export interface DependenciesFilterPatch {
  q?: string
  /** `[]` = show all types (distinct from absent, which applies the default). */
  type?: DepType[]
  updateKind?: UpdateKind[]
  /** Explicit boolean: `false` = include transitive (absent = default true). */
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
  /** Effective selection, defaults already applied by the route. */
  depType: DepType[]
  updateKind: UpdateKind[]
  direct: boolean
  hasVuln?: boolean
  /** Deviations from the DEFAULT view, computed by the route. */
  activeFilterCount: number
  onChange: (patch: DependenciesFilterPatch) => void
  onReset: () => void
}

/**
 * Search + faceted filters for the dependencies table. Type and update-kind
 * are multi-select facets (several values combine as OR); clearing every type
 * shows all of them. "Reset" returns to the default view: direct prod+dev.
 */
export function DependenciesToolbar({
  q,
  depType,
  updateKind,
  direct,
  hasVuln,
  activeFilterCount,
  onChange,
  onReset,
}: DependenciesToolbarProps) {
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
            multiple={true}
            selected={new Set(depType)}
            onChange={(selected) =>
              onChange({ type: [...selected] as DepType[] })
            }
          />
          <DataTableFacetedFilter
            title="Update"
            options={UPDATE_KIND_OPTIONS}
            multiple={true}
            selected={new Set(updateKind)}
            onChange={(selected) =>
              onChange({
                updateKind:
                  selected.size === 0
                    ? undefined
                    : ([...selected] as UpdateKind[]),
              })
            }
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
            pressed={direct}
            onPressedChange={(pressed) => onChange({ direct: pressed })}
          >
            Direct only
          </Toggle>
        </>
      }
    />
  )
}
