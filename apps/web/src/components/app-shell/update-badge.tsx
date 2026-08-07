import { useQuery } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { ArrowUpCircle, ExternalLink, X } from "lucide-react"
import { useState } from "react"
import { CopyButton } from "@/components/common/copy-button"
import { versionQueryOptions } from "@/features/system/api"

const DISMISSED_KEY = "understory.update-dismissed"
const UPDATE_COMMAND = "docker compose pull && docker compose up -d"

function dismissedVersion(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem(DISMISSED_KEY)
}

/**
 * Quiet one-liner above the user menu when a newer release exists. Clicking
 * it opens a dialog with update instructions and the release notes link.
 * Dismissal is per version: v0.0.2 dismissed stays hidden until v0.0.3.
 */
export function UpdateBadge() {
  const query = useQuery(versionQueryOptions())
  const [dismissed, setDismissed] = useState(dismissedVersion)
  const [open, setOpen] = useState(false)

  const status = query.data
  if (
    status === undefined ||
    !status.updateAvailable ||
    status.latestVersion === null ||
    status.latestVersion === dismissed
  ) {
    return null
  }

  const latest = status.latestVersion

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-md border border-sidebar-border px-2 py-1.5 group-data-[collapsible=icon]:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-w-0 items-center gap-1.5 font-heading text-sidebar-foreground/70 text-xs hover:text-sidebar-foreground"
        >
          <ArrowUpCircle className="size-3.5 shrink-0" />
          <span className="truncate">v{latest} available</span>
        </button>
        <button
          type="button"
          aria-label="Dismiss update notice"
          className="text-sidebar-foreground/50 hover:text-sidebar-foreground"
          onClick={() => {
            localStorage.setItem(DISMISSED_KEY, latest)
            setDismissed(latest)
          }}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update available</DialogTitle>
            <DialogDescription>
              You are running v{status.currentVersion.replace(/^v/, "")};
              version {latest} has been released.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            <p>
              Pull the new image and recreate the container on the host running
              understory:
            </p>
            <div className="flex items-center justify-between gap-2 rounded-md bg-muted py-1.5 pr-1.5 pl-3">
              <pre className="overflow-x-auto font-mono text-xs">
                {UPDATE_COMMAND}
              </pre>
              <CopyButton
                value={UPDATE_COMMAND}
                label="Copy update command"
                className="shrink-0 opacity-100"
              />
            </div>
            <p className="text-muted-foreground">
              Database migrations run automatically on startup. Your data lives
              in the <code>understory-data</code> volume — consider backing it
              up before major updates.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            {status.releaseUrl !== null && (
              <Button
                render={
                  // biome-ignore lint/a11y/useAnchorContent: Button injects the content
                  <a
                    href={status.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                Release notes
                <ExternalLink className="size-3.5" />
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
