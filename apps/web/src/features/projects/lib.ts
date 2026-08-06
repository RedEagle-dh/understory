interface LastScan {
  status: "running" | "ok" | "failed"
}

/** True while the given scan summary represents an in-flight scan. */
export function hasRunningScan(scan: LastScan | null | undefined): boolean {
  return scan?.status === "running"
}

/** True when any project in the list has a scan currently running. */
export function anyProjectScanning(
  projects: readonly { lastScan: LastScan | null }[] | undefined
): boolean {
  return (projects ?? []).some((project) => hasRunningScan(project.lastScan))
}
