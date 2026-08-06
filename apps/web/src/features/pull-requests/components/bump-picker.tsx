import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

export interface BumpOption {
  value: string
  label: string
}

interface BumpPickerProps {
  value: string | undefined
  options: BumpOption[]
  onChange: (value: string) => void
}

/**
 * Select over the versions available for one wizard row. When there's
 * nothing to pick from (no seeded target, nothing in the dependencies
 * cache) it renders a plain muted note instead — the plan still resolves a
 * target server-side, it's just not user-editable in that case.
 */
export function BumpPicker({ value, options, onChange }: BumpPickerProps) {
  if (options.length === 0) {
    return (
      <span className="font-heading text-muted-foreground text-xs">
        resolved by plan
      </span>
    )
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <SelectTrigger size="sm" className="h-7 w-44 font-heading text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className="font-heading text-xs"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
