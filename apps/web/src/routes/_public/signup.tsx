import { createFileRoute, redirect } from "@tanstack/react-router"
import { setupStatusQueryOptions } from "@/features/auth/api"
import { SignupForm } from "@/features/auth/components/signup-form"

export const Route = createFileRoute("/_public/signup")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(
      setupStatusQueryOptions()
    )
    if (!status.setupRequired) throw redirect({ to: "/login" })
  },
  component: SignupForm,
})
