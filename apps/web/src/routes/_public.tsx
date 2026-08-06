import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { SeveritySpectrum } from "@/components/common/severity-spectrum"
import { Wordmark } from "@/components/common/wordmark"
import { sessionQueryOptions } from "@/features/auth/api"

export const Route = createFileRoute("/_public")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(
      sessionQueryOptions()
    )
    if (session !== null) throw redirect({ to: "/" })
  },
  component: PublicLayout,
})

function PublicLayout() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6">
      <Wordmark />
      <div className="w-full max-w-sm space-y-0">
        <div className="px-6">
          <SeveritySpectrum />
        </div>
        <Outlet />
      </div>
      <p className="font-heading text-xs text-muted-foreground">
        self-hosted npm dependency auditing
      </p>
    </main>
  )
}
