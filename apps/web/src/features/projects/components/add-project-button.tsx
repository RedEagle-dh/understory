import { Button } from "@workspace/ui/components/button"
import { useAddProjectFlow } from "../add-project-context"

/** Opens the shared add-project dialog (mounted at the authed layout). */
export function AddProjectButton() {
  const { setOpen } = useAddProjectFlow()

  return <Button onClick={() => setOpen(true)}>Add project</Button>
}
