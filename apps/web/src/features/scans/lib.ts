interface ScanStatusRow {
  status: "running" | "ok" | "failed"
}

/** True when any scan row in a page is still running — drives the poll interval. */
export function anyScanRunning(
  scans: readonly ScanStatusRow[] | undefined
): boolean {
  return (scans ?? []).some((scan) => scan.status === "running")
}

export type ScanTrigger = "schedule" | "manual" | "auto"

/** Copy + badge variant shared by the scans table and the scan detail header. */
export const TRIGGER_LABEL: Record<ScanTrigger, string> = {
  schedule: "scheduled",
  manual: "manual",
  auto: "auto",
}

export const TRIGGER_VARIANT: Record<
  ScanTrigger,
  "outline" | "secondary" | "default"
> = {
  schedule: "outline",
  manual: "secondary",
  auto: "default",
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—"
  return `${(durationMs / 1000).toFixed(1)}s`
}
