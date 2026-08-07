import { createContext, useContext, useMemo, useState } from "react"

interface AddProjectFlowValue {
  open: boolean
  setOpen: (open: boolean) => void
}

const AddProjectContext = createContext<AddProjectFlowValue | null>(null)

/**
 * Mounted once at the authed layout alongside `AddProjectDialog` — every
 * entry point (sidebar, projects page, dashboard empty state, command
 * palette) opens the same dialog instance via `useAddProjectFlow()`.
 */
export function AddProjectProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const value = useMemo(() => ({ open, setOpen }), [open])

  return (
    <AddProjectContext.Provider value={value}>
      {children}
    </AddProjectContext.Provider>
  )
}

export function useAddProjectFlow(): AddProjectFlowValue {
  const value = useContext(AddProjectContext)
  if (value === null) {
    throw new Error("useAddProjectFlow requires an AddProjectProvider")
  }
  return value
}
