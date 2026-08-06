import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { api } from "@/lib/api"
import { ApiError, unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"
import { anyProjectScanning, hasRunningScan } from "./lib"

/** Fleet-wide project list, with vuln/outdated rollups and last-scan status. */
export function projectsQueryOptions() {
  return queryOptions({
    queryKey: qk.projects(),
    queryFn: async () => unwrap(await api.api.projects.get()),
    refetchInterval: (query) =>
      anyProjectScanning(query.state.data?.projects) ? 5000 : false,
  })
}

async function fetchProject(projectId: string) {
  return unwrap(await api.api.projects({ projectId }).get())
}

/** Single project's settings + last scan. */
export function projectQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: qk.project(projectId),
    queryFn: () => fetchProject(projectId),
    refetchInterval: (query) =>
      hasRunningScan(query.state.data?.lastScan) ? 5000 : false,
  })
}

/** The full project settings shape (`ProjectView` + `lastScan`) shared by every settings card. */
export type ProjectDetail = Awaited<ReturnType<typeof fetchProject>>

interface CreateProjectInput {
  name?: string
  owner: string
  repo: string
  branch?: string
  token?: string
}

export function useCreateProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreateProjectInput) =>
      unwrap(await api.api.projects.post(input)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.projects() })
    },
  })
}

export interface ProjectUpdateInput {
  name?: string
  branch?: string
  manifestPaths?: string[] | null
  scanIntervalMinutes?: number
  paused?: boolean
  autoPrEnabled?: boolean
  autoPrMinSeverity?: "low" | "moderate" | "high" | "critical"
  autoPrMaxBump?: "patch" | "minor" | "major"
  autoBumpEnabled?: boolean
  autoBumpMaxKind?: "patch" | "minor" | "major"
  autoBumpMinReleaseAgeHours?: number
  prBaseBranch?: string | null
  prLabels?: string[] | null
  regenerateLockfile?: boolean
  notifyOnNewMajor?: boolean
}

/** Partial update to a project's settings. Invalidates the whole `qk.project(id)` prefix. */
export function useProjectUpdate(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (patch: ProjectUpdateInput) =>
      unwrap(await api.api.projects({ projectId }).patch(patch)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.project(projectId) })
    },
  })
}

/** Stores (or replaces) the project-scoped GitHub token. Never echoes the token back. */
export function useSetProjectToken(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (token: string) =>
      unwrap(await api.api.projects({ projectId }).token.put({ token })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.project(projectId) })
    },
  })
}

/** Removes the project-scoped GitHub token, falling back to the instance default (if any). */
export function useDeleteProjectToken(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () =>
      unwrap(await api.api.projects({ projectId }).token.delete()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.project(projectId) })
    },
  })
}

/** Verifies repo access with the currently stored (or default) token; doesn't mutate anything. */
export function useTestConnection(projectId: string) {
  return useMutation({
    mutationFn: async () =>
      unwrap(await api.api.projects({ projectId })["test-connection"].post()),
  })
}

/** Deletes a project and all its data. Callers are responsible for navigating away. */
export function useDeleteProject(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () =>
      unwrap(await api.api.projects({ projectId }).delete()),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: qk.project(projectId) })
      await queryClient.invalidateQueries({ queryKey: qk.projects() })
    },
  })
}

/**
 * Triggers a manual scan. Optimistically flips `lastScan.status` to
 * "running" in both the list and detail caches so pollers on either screen
 * engage immediately, without waiting for the 202 response to round-trip.
 */
export function useTriggerScan(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () =>
      unwrap(await api.api.projects({ projectId }).scans.post()),
    meta: {
      toast: (error) => {
        if (error instanceof ApiError && error.status === 409) {
          return {
            title: "Scan already running",
            description: "A scan is already running for this project.",
          }
        }
        return undefined
      },
    },
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: qk.projects() }),
        queryClient.cancelQueries({ queryKey: qk.project(projectId) }),
      ])

      const previousList = queryClient.getQueryData(
        projectsQueryOptions().queryKey
      )
      const previousDetail = queryClient.getQueryData(
        projectQueryOptions(projectId).queryKey
      )
      const runningScan = {
        id: previousDetail?.lastScan?.id ?? "",
        status: "running" as const,
        trigger: "manual" as const,
        startedAt: new Date(),
        finishedAt: null,
        errorCode: null,
      }

      queryClient.setQueryData(projectsQueryOptions().queryKey, (data) => {
        if (data === undefined) return data
        return {
          ...data,
          projects: data.projects.map((project) =>
            project.id === projectId
              ? { ...project, lastScan: runningScan }
              : project
          ),
        }
      })
      queryClient.setQueryData(
        projectQueryOptions(projectId).queryKey,
        (data) => {
          if (data === undefined) return data
          return { ...data, lastScan: runningScan }
        }
      )

      return { previousList, previousDetail }
    },
    onError: (_error, _vars, context) => {
      if (context?.previousList !== undefined) {
        queryClient.setQueryData(
          projectsQueryOptions().queryKey,
          context.previousList
        )
      }
      if (context?.previousDetail !== undefined) {
        queryClient.setQueryData(
          projectQueryOptions(projectId).queryKey,
          context.previousDetail
        )
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: qk.projects() }),
      ])
    },
  })
}

/**
 * The project queries only refetch the project row itself while a scan is
 * running (see `refetchInterval` above) — they don't know that dependencies,
 * vulnerabilities and scan history all need a refresh too once the scan
 * lands. Watching for the running→ok transition and invalidating the whole
 * `qk.project(id)` prefix covers scans started elsewhere (schedule, another
 * user) as well as ones triggered from this tab.
 */
export function useInvalidateProjectOnScanComplete(
  projectId: string,
  status: "running" | "ok" | "failed" | undefined
) {
  const queryClient = useQueryClient()
  const previous = useRef(status)

  useEffect(() => {
    if (previous.current === "running" && status === "ok") {
      void queryClient.invalidateQueries({ queryKey: qk.project(projectId) })
    }
    previous.current = status
  }, [status, projectId, queryClient])
}

/** Same watcher, fanned out over the whole fleet for the dashboard grid. */
export function useInvalidateFleetOnScanComplete(
  projects:
    | readonly {
        id: string
        lastScan: { status: "running" | "ok" | "failed" } | null
      }[]
    | undefined
) {
  const queryClient = useQueryClient()
  const previous = useRef(new Map<string, string>())

  useEffect(() => {
    if (projects === undefined) return
    for (const project of projects) {
      const prevStatus = previous.current.get(project.id)
      const currentStatus = project.lastScan?.status
      if (prevStatus === "running" && currentStatus === "ok") {
        void queryClient.invalidateQueries({ queryKey: qk.project(project.id) })
      }
      if (currentStatus !== undefined) {
        previous.current.set(project.id, currentStatus)
      }
    }
  }, [projects, queryClient])
}
