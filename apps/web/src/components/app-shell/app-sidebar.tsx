import { useQuery } from "@tanstack/react-query"
import { Link, useMatchRoute } from "@tanstack/react-router"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { cn } from "@workspace/ui/lib/utils"
import type { LucideIcon } from "lucide-react"
import {
  Bell,
  FolderKanban,
  LayoutDashboard,
  SlidersHorizontal,
  UserCircle,
  Users,
} from "lucide-react"
import { RoleGate } from "@/components/common/role-gate"
import { Wordmark } from "@/components/common/wordmark"
import { projectsQueryOptions } from "@/features/projects/api"
import { NavUser } from "./nav-user"
import { UpdateBadge } from "./update-badge"

const RECENT_PROJECTS_LIMIT = 8

function severityDotClass(vulnCounts: { critical: number; high: number }) {
  if (vulnCounts.critical > 0) return "bg-severity-critical"
  if (vulnCounts.high > 0) return "bg-severity-high"
  return "bg-muted-foreground/40"
}

/** Up to 8 recent projects, each with a severity dot. Renders nothing while loading. */
function RecentProjects() {
  const query = useQuery(projectsQueryOptions())
  const projects = query.data?.projects.slice(0, RECENT_PROJECTS_LIMIT) ?? []

  return (
    <>
      {projects.map((project) => (
        <SidebarMenuItem key={project.id}>
          <SidebarMenuButton
            size="sm"
            render={
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
              />
            }
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                severityDotClass(project.vulnCounts)
              )}
            />
            <span className="truncate">{project.name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </>
  )
}

function NavLink({
  to,
  icon: Icon,
  label,
  exact = false,
}: {
  to: string
  icon: LucideIcon
  label: string
  exact?: boolean
}) {
  const matchRoute = useMatchRoute()
  const isActive = Boolean(matchRoute({ to, fuzzy: !exact }))

  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={isActive} render={<Link to={to} />}>
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <Wordmark />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Overview</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavLink to="/" icon={LayoutDashboard} label="Dashboard" exact />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavLink
                to="/projects"
                icon={FolderKanban}
                label="All projects"
                exact
              />
              <RecentProjects />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Settings</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <RoleGate capability="manageNotifications">
                <NavLink
                  to="/settings/notifications"
                  icon={Bell}
                  label="Notifications"
                />
              </RoleGate>
              <RoleGate capability="manageUsers">
                <NavLink to="/settings/users" icon={Users} label="Users" />
              </RoleGate>
              <RoleGate capability="manageSettings">
                <NavLink
                  to="/settings/defaults"
                  icon={SlidersHorizontal}
                  label="Defaults"
                />
              </RoleGate>
              <NavLink
                to="/settings/profile"
                icon={UserCircle}
                label="Profile"
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UpdateBadge />
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  )
}
