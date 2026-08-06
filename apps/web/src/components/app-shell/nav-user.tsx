import { Link, useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronsUpDown, LogOut, Moon, Sun, UserCircle } from "lucide-react"
import { Avatar, AvatarFallback } from "@workspace/ui/components/avatar"
import { Badge } from "@workspace/ui/components/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { useTheme } from "@/components/theme/theme-provider"
import { useSession } from "@/features/auth/use-permissions"
import { authClient } from "@/lib/auth-client"
import { qk } from "@/lib/query-keys"

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? ""
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : ""
  return (first + last).toUpperCase() || "?"
}

export function NavUser() {
  const { data: session } = useSession()
  const { resolvedTheme, setTheme } = useTheme()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  if (!session) return null
  const { user } = session
  const displayName = user.name.length > 0 ? user.name : user.email

  const handleSignOut = async () => {
    await authClient.signOut()
    queryClient.setQueryData(qk.session(), null)
    await navigate({ to: "/login" })
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
            <Avatar size="sm">
              <AvatarFallback>{initials(displayName)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-sm font-medium">
                {displayName}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {user.email}
              </span>
            </div>
            <ChevronsUpDown className="ml-auto text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-64">
            {/* Base UI: GroupLabel must live inside a Menu.Group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center justify-between gap-2 font-normal">
                <span className="truncate text-muted-foreground">
                  {user.email}
                </span>
                <Badge variant="secondary" className="capitalize">
                  {user.role ?? "viewer"}
                </Badge>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/settings/profile" />}>
              <UserCircle />
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
              {resolvedTheme === "dark" ? "Light theme" : "Dark theme"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => void handleSignOut()}
            >
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
