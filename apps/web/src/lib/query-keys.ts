/**
 * Hierarchical query-key factory. Prefix invalidation is the contract:
 * `invalidateQueries({ queryKey: qk.project(id) })` refreshes everything
 * belonging to one project after a scan completes.
 */
export const qk = {
  setupStatus: () => ["setup-status"] as const,
  session: () => ["session"] as const,
  dashboard: () => ["dashboard", "summary"] as const,
  projects: () => ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  dependencies: (id: string) => ["projects", id, "dependencies"] as const,
  vulns: (id: string) => ["projects", id, "vulnerabilities"] as const,
  finding: (findingId: string) => ["findings", findingId] as const,
  scans: (id: string) => ["projects", id, "scans"] as const,
  scan: (id: string, scanId: string) =>
    ["projects", id, "scans", scanId] as const,
  scanDiff: (scanId: string) => ["scans", scanId, "diff"] as const,
  prs: (id: string) => ["projects", id, "pull-requests"] as const,
  channels: () => ["notifications", "channels"] as const,
  rules: (scope: string) => ["notifications", "rules", scope] as const,
  deliveries: () => ["notifications", "deliveries"] as const,
  users: () => ["users"] as const,
  version: () => ["system", "version"] as const,
  adminSettings: () => ["admin-settings"] as const,
} as const
