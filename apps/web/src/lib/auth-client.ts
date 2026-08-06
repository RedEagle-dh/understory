import { createAuthClient } from "better-auth/react"
import { adminClient } from "better-auth/client/plugins"
import { createAccessControl } from "better-auth/plugins/access"

/**
 * Client-side mirror of the API's role *names* only (see
 * apps/api/src/auth/permissions.ts) — the statements here are a stub, never
 * evaluated client-side. Their only job is giving `adminClient` something to
 * infer `"viewer" | "maintainer" | "admin"` literal types from for
 * `setRole`/`createUser`, instead of the plugin's built-in `"admin" | "user"`.
 */
const roleAccessControl = createAccessControl({ app: ["access"] } as const)
const authRoles = {
  viewer: roleAccessControl.newRole({}),
  maintainer: roleAccessControl.newRole({}),
  admin: roleAccessControl.newRole({}),
}

export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost:3001" : undefined,
  plugins: [adminClient({ roles: authRoles })],
})

export type Session = typeof authClient.$Infer.Session
export type SessionUser = Session["user"]
