import { useNavigate } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { toast } from "@workspace/ui/components/toast"
import { useState } from "react"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import type { ProjectDetail } from "@/features/projects/api"
import { useDeleteProject } from "@/features/projects/api"

/** Destructive-bordered card, isolated at the bottom of the settings page. */
export function DangerZoneCard({ project }: { project: ProjectDetail }) {
  const navigate = useNavigate()
  const deleteProject = useDeleteProject(project.id)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const requireText = `${project.owner}/${project.repo}`

  return (
    <Card className="ring-destructive/30">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Deleting a project removes its dependency history, scans, and pull
          request records. This can't be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="destructive"
          className="self-start"
          onClick={() => setConfirmOpen(true)}
        >
          Delete project
        </Button>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete project"
        description={`Type "${requireText}" to confirm. This permanently deletes ${requireText} and all of its data.`}
        confirmLabel="Delete project"
        destructive
        requireText={requireText}
        onConfirm={async () => {
          await deleteProject.mutateAsync()
          toast.add({
            title: "Project deleted",
            description: `${requireText} and its data were removed.`,
          })
          await navigate({ to: "/" })
        }}
      />
    </Card>
  )
}
