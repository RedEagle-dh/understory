import { createFileRoute, redirect } from "@tanstack/react-router"
import { SignupForm } from "@/features/auth/components/signup-form"
import { setupStatusQueryOptions } from "@/features/auth/api"

export const Route = createFileRoute("/_public/signup")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(
      setupStatusQueryOptions()
    )
    if (!status.setupRequired) throw redirect({ to: "/login" })
  },
  component: SignupForm,
})
