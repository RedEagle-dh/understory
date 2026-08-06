import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar"
import { AppSidebar } from "./app-sidebar"
import { AppTopbar } from "./app-topbar"
import { CommandPalette } from "./command-palette"

/** The authed app frame: sidebar + topbar + content slot. Mounted once by `_authed.tsx`. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppTopbar />
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
  )
}
