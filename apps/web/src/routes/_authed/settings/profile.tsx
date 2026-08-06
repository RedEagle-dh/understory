import { createFileRoute } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { UserCircle } from "lucide-react"
import { PageHeader } from "@/components/states/page-header"
import { QueryBoundary } from "@/components/states/query-boundary"
import { ChangePasswordForm } from "@/features/auth/components/change-password-form"
import { useSession } from "@/features/auth/use-permissions"
import { formatAbsoluteDate } from "@/lib/format"
import { buildPermissions } from "@/lib/permissions"

export const Route = createFileRoute("/_authed/settings/profile")({
  staticData: { crumb: "Profile" },
  head: () => ({ meta: [{ title: "Profile · understory" }] }),
  component: ProfileSettings,
})

const ROLE_LABELS = {
  viewer: "Viewer",
  maintainer: "Maintainer",
  admin: "Admin",
}

function ProfileSettings() {
  const session = useSession()

  return (
    <>
      <PageHeader
        title="Profile"
        description="Your name, email, and password."
      />
      <div className="flex max-w-lg flex-col gap-6">
        <QueryBoundary
          query={session}
          skeleton={<div className="h-40 animate-pulse rounded-lg bg-muted" />}
        >
          {(data) => {
            if (data === null) return null
            const role = buildPermissions(data.user.role).role
            return (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <UserCircle className="size-4" />
                    Account
                  </CardTitle>
                  <CardDescription>
                    Your identity on this instance.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>Name</FieldLabel>
                      <p className="text-sm">{data.user.name}</p>
                    </Field>
                    <Field>
                      <FieldLabel>Email</FieldLabel>
                      <p className="font-heading text-muted-foreground text-sm">
                        {data.user.email}
                      </p>
                    </Field>
                    <Field orientation="horizontal">
                      <FieldLabel className="flex-1">Role</FieldLabel>
                      <Badge variant="outline" className="font-heading">
                        {ROLE_LABELS[role]}
                      </Badge>
                    </Field>
                    <Field orientation="horizontal">
                      <FieldLabel className="flex-1">Member since</FieldLabel>
                      <p className="text-muted-foreground text-sm">
                        {formatAbsoluteDate(data.user.createdAt)}
                      </p>
                    </Field>
                  </FieldGroup>
                </CardContent>
              </Card>
            )
          }}
        </QueryBoundary>

        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              Changing your password signs out every other session.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </div>
    </>
  )
}
