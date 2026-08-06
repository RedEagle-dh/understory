import { Skeleton } from "@workspace/ui/components/skeleton"

interface DataTableSkeletonProps {
  columns?: number
  rows?: number
}

/** Loading placeholder shaped like the table it's standing in for. */
export function DataTableSkeleton({
  columns = 6,
  rows = 8,
}: DataTableSkeletonProps) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center gap-4 border-b p-2">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="flex items-center gap-4 border-b p-2 last:border-0"
        >
          {Array.from({ length: columns }, (_, colIndex) => (
            <Skeleton key={colIndex} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}
