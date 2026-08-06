/**
 * UI-side role gating. Single source of truth for which role unlocks which
 * capability. This is UX only — the API enforces the real policy per route.
 */
export type Role = "viewer" | "maintainer" | "admin"

export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  maintainer: 1,
  admin: 2,
}

export type Capability =
  | "scan"
  | "createPr"
  | "createProject"
  | "editProject"
  | "deleteProject"
  | "manageNotifications"
  | "manageUsers"
  | "manageSettings"

const CAPABILITY_MIN: Record<Capability, Role> = {
  scan: "maintainer",
  createPr: "maintainer",
  createProject: "maintainer",
  editProject: "maintainer",
  deleteProject: "maintainer",
  manageNotifications: "maintainer",
  manageUsers: "admin",
  manageSettings: "admin",
}

export interface Permissions {
  role: Role
  has: (capability: Capability) => boolean
}

export function buildPermissions(role: string | null | undefined): Permissions {
  const resolved: Role =
    role === "admin" || role === "maintainer" ? role : "viewer"
  return {
    role: resolved,
    has: (capability) =>
      ROLE_RANK[resolved] >= ROLE_RANK[CAPABILITY_MIN[capability]],
  }
}
