import { createFileRoute, Link } from "@tanstack/react-router"
import { z } from "zod"
import { setupStatusQueryOptions } from "@/features/auth/api"
import { LoginForm } from "@/features/auth/components/login-form"

const searchSchema = z.object({
  redirect: z.string().optional(),
})

export const Route = createFileRoute("/_public/login")({
  validateSearch: searchSchema,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(setupStatusQueryOptions()),
  component: LoginPage,
})

function LoginPage() {
  const { redirect } = Route.useSearch()
  const setup = Route.useLoaderData()

  return (
    <div className="flex flex-col gap-4">
      <LoginForm redirectTo={redirect} />
      {setup.setupRequired && (
        <p className="text-center text-muted-foreground text-sm">
          First run?{" "}
          <Link to="/signup" className="text-foreground underline">
            Create the admin account
          </Link>
        </p>
      )}
    </div>
  )
}
