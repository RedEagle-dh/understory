import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react"
import type { PrSeedSelection } from "./api"

interface CreatePrFlowValue {
  open: boolean
  seed: PrSeedSelection[]
  /** Opens the wizard seeded with these selections, replacing any prior seed. */
  openWith: (selections: PrSeedSelection[]) => void
  close: () => void
}

const CreatePrFlowContext = createContext<CreatePrFlowValue | null>(null)

/**
 * Mounted once at the project layout (`$projectId.tsx`) alongside
 * `CreatePrSheet` — every entry point (dependencies bulk bar, dependency
 * detail sheet, advisory "fix with PR") reaches the same wizard instance via
 * `useCreatePrFlow().openWith(...)` instead of managing its own sheet state.
 */
export function CreatePrFlowProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState<PrSeedSelection[]>([])

  const openWith = useCallback((selections: PrSeedSelection[]) => {
    setSeed(selections)
    setOpen(true)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const value = useMemo(
    () => ({ open, seed, openWith, close }),
    [open, seed, openWith, close]
  )

  return (
    <CreatePrFlowContext.Provider value={value}>
      {children}
    </CreatePrFlowContext.Provider>
  )
}

export function useCreatePrFlow(): CreatePrFlowValue {
  const context = useContext(CreatePrFlowContext)
  if (context === null) {
    throw new Error("useCreatePrFlow must be used within CreatePrFlowProvider")
  }
  return context
}
