import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Toggle } from "@workspace/ui/components/toggle"
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar"
import type { FindingState } from "../api"

/** Matches the vulnerabilities route's search schema field names exactly. */
export interface VulnerabilitiesFilterPatch {
  q?: string
  state?: FindingState
  fixable?: boolean
  direct?: boolean
}

const STATE_OPTIONS: { label: string; value: FindingState }[] = [
  { label: "Open", value: "open" },
  { label: "Resolved", value: "resolved" },
  { label: "Ignored", value: "ignored" },
]

interface VulnerabilitiesToolbarProps {
  q: string
  state: FindingState
  fixable?: boolean
  direct?: boolean
  onChange: (patch: VulnerabilitiesFilterPatch) => void
  onReset: () => void
}

export function VulnerabilitiesToolbar({
  q,
  state,
  fixable,
  direct,
  onChange,
  onReset,
}: VulnerabilitiesToolbarProps) {
  const activeFilterCount =
    (state !== "open" ? 1 : 0) +
    (fixable === true ? 1 : 0) +
    (direct === true ? 1 : 0) +
    (q !== "" ? 1 : 0)

  return (
    <DataTableToolbar
      searchValue={q}
      onSearchChange={(value) =>
        onChange({ q: value === "" ? undefined : value })
      }
      searchPlaceholder="Search advisories or packages..."
      activeFilterCount={activeFilterCount}
      onReset={onReset}
      filters={
        <>
          <Select
            value={state}
            onValueChange={(value) => {
              if (value !== null) onChange({ state: value as FindingState })
            }}
          >
            <SelectTrigger size="sm" className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Toggle
            variant="outline"
            size="sm"
            pressed={fixable === true}
            onPressedChange={(pressed) =>
              onChange({ fixable: pressed ? true : undefined })
            }
          >
            Fixable only
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
