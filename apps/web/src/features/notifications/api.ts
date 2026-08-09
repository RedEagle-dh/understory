import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"

export type ChannelType =
  | "email_resend"
  | "discord_webhook"
  | "slack_webhook"
  | "webhook"
export type EventType =
  | "new_vulnerabilities"
  | "resolved_vulnerabilities"
  | "new_major"
  | "outdated_digest"
  | "pr_opened"
  | "pr_merged"
  | "scan_failed"
export type Severity = "low" | "moderate" | "high" | "critical"
export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped"

export const EVENT_TYPES: readonly EventType[] = [
  "new_vulnerabilities",
  "resolved_vulnerabilities",
  "new_major",
  "outdated_digest",
  "pr_opened",
  "pr_merged",
  "scan_failed",
]

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  new_vulnerabilities: "New vulnerabilities",
  resolved_vulnerabilities: "Resolved vulnerabilities",
  new_major: "New major version",
  outdated_digest: "Outdated digest",
  pr_opened: "Pull request opened",
  pr_merged: "Pull request merged",
  scan_failed: "Scan failed",
}

/** Event types where a minimum severity threshold is meaningful. */
export const SEVERITY_SCOPED_EVENT_TYPES = new Set<EventType>([
  "new_vulnerabilities",
  "resolved_vulnerabilities",
])

async function fetchChannels() {
  return unwrap(
    await api.api["notification-channels"].get({ query: { pageSize: 200 } })
  )
}

/** All configured notification channels (never returns secrets — see `configPublic`). */
export function channelsQueryOptions() {
  return queryOptions({
    queryKey: qk.channels(),
    queryFn: fetchChannels,
  })
}

export type ChannelListItem = Awaited<
  ReturnType<typeof fetchChannels>
>["items"][number]

/** '' (falsy) collapses to the "global" scope both the query key and the API use. */
function rulesScope(projectId: string): string {
  return projectId || "global"
}

async function fetchRules(projectId: string) {
  return unwrap(
    await api.api["notification-rules"].get({
      query: { projectId, pageSize: 200 },
    })
  )
}

/** Notification rules for one project, or the global rules when `projectId` is `''`. */
export function rulesQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: qk.rules(rulesScope(projectId)),
    queryFn: () => fetchRules(projectId),
  })
}

export type RuleListItem = Awaited<
  ReturnType<typeof fetchRules>
>["items"][number]

export interface DeliveriesParams {
  channelId?: string
  status?: DeliveryStatus
}

async function fetchDeliveries(params: DeliveriesParams) {
  return unwrap(
    await api.api["notification-deliveries"].get({
      query: { ...params, page: 1, pageSize: 20 },
    })
  )
}

/** Read-only delivery log, page 1 only — the settings screen just wants a recent-activity glance. */
export function deliveriesQueryOptions(params: DeliveriesParams = {}) {
  return queryOptions({
    queryKey: [...qk.deliveries(), params] as const,
    queryFn: () => fetchDeliveries(params),
    placeholderData: keepPreviousData,
  })
}

export type DeliveryListItem = Awaited<
  ReturnType<typeof fetchDeliveries>
>["items"][number]

export interface CreateChannelInput {
  name: string
  type: ChannelType
  config: Record<string, unknown>
  enabled?: boolean
}

export function useCreateChannel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreateChannelInput) =>
      unwrap(await api.api["notification-channels"].post(input)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.channels() })
    },
  })
}

export interface UpdateChannelInput {
  channelId: string
  name?: string
  enabled?: boolean
  config?: Record<string, unknown>
}

/** Config fields absent from `patch` are left untouched server-side — that's what makes "unchanged" secret editing possible. */
export function useUpdateChannel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ channelId, ...patch }: UpdateChannelInput) =>
      unwrap(
        await api.api["notification-channels"]({ channelId }).patch(patch)
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.channels() })
    },
  })
}

export function useDeleteChannel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (channelId: string) =>
      unwrap(await api.api["notification-channels"]({ channelId }).delete()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.channels() })
    },
  })
}

/** Verifies credentials without necessarily sending a real message (provider-dependent). */
export function useTestChannel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (channelId: string) =>
      unwrap(await api.api["notification-channels"]({ channelId }).test.post()),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.channels() })
    },
  })
}

export interface UpsertRuleInput {
  channelId: string
  eventType: EventType
  minSeverity?: Severity | null
  enabled?: boolean
}

/** Creates or updates the rule for (channel, project scope, event type) — the API upserts on that triple. */
export function useUpsertRule(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: UpsertRuleInput) =>
      unwrap(await api.api["notification-rules"].put({ ...input, projectId })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: qk.rules(rulesScope(projectId)),
      })
    },
  })
}

export function useDeleteRule(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (ruleId: string) =>
      unwrap(await api.api["notification-rules"]({ ruleId }).delete()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: qk.rules(rulesScope(projectId)),
      })
    },
  })
}
