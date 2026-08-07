import { useNavigate } from "@tanstack/react-router"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command"
import type { LucideIcon } from "lucide-react"
import {
  Bell,
  FolderKanban,
  FolderPlus,
  LayoutDashboard,
  UserCircle,
  Users,
} from "lucide-react"
import { useEffect, useState } from "react"
import { usePermissions } from "@/features/auth/use-permissions"
import type { Capability } from "@/lib/permissions"

interface PaletteItem {
  label: string
  to: string
  icon: LucideIcon
  capability?: Capability
}

const items: PaletteItem[] = [
  { label: "Dashboard", to: "/", icon: LayoutDashboard },
  { label: "All projects", to: "/projects", icon: FolderKanban },
  {
    label: "Add project",
    to: "/projects/new",
    icon: FolderPlus,
    capability: "createProject",
  },
  { label: "Profile settings", to: "/settings/profile", icon: UserCircle },
  {
    label: "Notification settings",
    to: "/settings/notifications",
    icon: Bell,
    capability: "manageNotifications",
  },
  {
    label: "User management",
    to: "/settings/users",
    icon: Users,
    capability: "manageUsers",
  },
]

/** ⌘K / Ctrl+K palette for jumping straight to a page, filtered by role. */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const permissions = usePermissions()

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [])

  const visible = items.filter(
    (item) => item.capability === undefined || permissions.has(item.capability)
  )

  const go = (to: string) => {
    setOpen(false)
    void navigate({ to })
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search for a page..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigation">
          {visible.map((item) => (
            <CommandItem key={item.to} onSelect={() => go(item.to)}>
              <item.icon />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
