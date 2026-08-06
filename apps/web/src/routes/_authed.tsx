import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { AppShell } from "@/components/app-shell/app-shell"
import { sessionQueryOptions } from "@/features/auth/api"
import { buildPermissions } from "@/lib/permissions"

export const Route = createFileRoute("/_authed")({
  // This app is SPA-only (see vite.config.ts `tanstackStart({ spa: { enabled: true } })`),
  // so route context never crosses an SSR serialization boundary. Declaring that here
  // lets `can` (a Permissions object with a `has()` method) live in route context —
  // without it, TanStack Router's SSR-serializability check rejects non-serializable
  // context values.
  ssr: false,
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(
      sessionQueryOptions()
    )
    if (session === null) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
    return { session, can: buildPermissions(session.user.role) }
  },
  component: AuthedLayout,
})

function AuthedLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
