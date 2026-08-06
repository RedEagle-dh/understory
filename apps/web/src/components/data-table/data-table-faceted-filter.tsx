import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Separator } from "@workspace/ui/components/separator"
import { cn } from "@workspace/ui/lib/utils"
import { CheckIcon, PlusCircle } from "lucide-react"

export interface FacetedFilterOption {
  label: string
  value: string
  count?: number
}

interface DataTableFacetedFilterProps {
  title: string
  options: FacetedFilterOption[]
  selected: Set<string>
  onChange: (selected: Set<string>) => void
  /**
   * The dependencies API only accepts one value for depType/updateKind —
   * `multiple={false}` makes selecting an option replace rather than add to
   * the selection (and re-selecting it clears the filter).
   */
  multiple?: boolean
}

/** Popover + Command multi (or single) select with per-option counts. */
export function DataTableFacetedFilter({
  title,
  options,
  selected,
  onChange,
  multiple = true,
}: DataTableFacetedFilterProps) {
  const toggle = (value: string) => {
    const next = new Set(selected)
    if (multiple) {
      if (next.has(value)) next.delete(value)
      else next.add(value)
    } else {
      next.clear()
      if (!selected.has(value)) next.add(value)
    }
    onChange(next)
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="border-dashed" />
        }
      >
        <PlusCircle />
        {title}
        {selected.size > 0 && (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <Badge variant="secondary" className="rounded-sm px-1 font-normal">
              {selected.size}
            </Badge>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selected.has(option.value)
                return (
                  <CommandItem
                    key={option.value}
                    onSelect={() => toggle(option.value)}
                  >
                    <span
                      className={cn(
                        "flex size-4 items-center justify-center rounded-sm border border-primary",
                        isSelected
                          ? "bg-primary text-primary-foreground"
                          : "opacity-50 [&_svg]:invisible"
                      )}
                    >
                      <CheckIcon className="size-3.5" />
                    </span>
                    <span>{option.label}</span>
                    {option.count !== undefined && (
                      <span className="ml-auto font-heading text-muted-foreground text-xs">
                        {option.count}
                      </span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
