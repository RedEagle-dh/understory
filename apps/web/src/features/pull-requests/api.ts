import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { api } from "@/lib/api"
import { ApiError, unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"

export type PrState = "creating" | "open" | "merged" | "closed" | "failed"
export type PrKind = "manual" | "auto_security"

export interface PrsParams {
  state?: PrState
  page: number
  pageSize: number
}

async function fetchPrs(projectId: string, params: PrsParams) {
  return unwrap(
    await api.api
      .projects({ projectId })
      ["pull-requests"].get({ query: params })
  )
}

function anyCreating(items: readonly { state: PrState }[] | undefined) {
  return items?.some((item) => item.state === "creating") ?? false
}

/** Pull requests opened for a project, paged server-side. Polls every 5s while any row is still `creating`. */
export function prsQueryOptions(projectId: string, params: PrsParams) {
  return queryOptions({
    queryKey: [...qk.prs(projectId), params] as const,
    queryFn: () => fetchPrs(projectId, params),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      anyCreating(query.state.data?.items) ? 5000 : false,
  })
}

export type PrListItem = Awaited<ReturnType<typeof fetchPrs>>["items"][number]

/**
 * Selection as edited in the wizard. `hint` is UI-only (labels the
 * BumpPicker option it came from) and is stripped before the request body
 * is built — the wire shape is just `{ name, workspace?, toVersion? }`.
 */
export interface PrSeedSelection {
  name: string
  workspace?: string
  toVersion?: string
  hint?: "fix" | "latest"
}

export interface PrSelectionInput {
  name: string
  workspace?: string
  toVersion?: string
}

export function toApiSelections(
  selections: readonly PrSeedSelection[]
): PrSelectionInput[] {
  return selections.map(({ name, workspace, toVersion }) => ({
    name,
    workspace,
    toVersion,
  }))
}

async function fetchPlan(projectId: string, selections: PrSelectionInput[]) {
  return unwrap(
    await api.api
      .projects({ projectId })
      ["pull-requests"].plan.post({ selections })
  )
}

export type PrPlan = Awaited<ReturnType<typeof fetchPlan>>
export type PrPlanItem = PrPlan["items"][number]

/** Dry-runs a bump selection: manifest edits, drops, conflicts — no repository is touched. */
export function usePlanPr(projectId: string) {
  return useMutation({
    mutationFn: (selections: PrSelectionInput[]) =>
      fetchPlan(projectId, selections),
  })
}

/** Pulls the first http(s) URL out of an error message (the PR_ALREADY_OPEN detail embeds one). */
function extractUrl(message: string): string | undefined {
  return message.match(/https?:\/\/\S+/)?.[0]
}

/** Opens the pull request. Invalidates every `qk.prs(id)` query on success. */
export function useCreatePr(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (selections: PrSelectionInput[]) =>
      unwrap(
        await api.api
          .projects({ projectId })
          ["pull-requests"].post({ selections })
      ),
    meta: {
      toast: (error) => {
        if (error instanceof ApiError && error.status === 409) {
          return {
            title: "A pull request already covers this",
            description: extractUrl(error.detail) ?? error.detail,
          }
        }
        return undefined
      },
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.prs(projectId) })
    },
  })
}

/** Refreshes one pull request's state from GitHub. */
export function useSyncPr(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (prId: string) =>
      unwrap(await api.api["pull-requests"]({ prId }).sync.post()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.prs(projectId) })
    },
  })
}
