import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { api } from "@/lib/api"
import { unwrap } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"

/** Instance-wide defaults: scan cadence and retention. Admin-only (`manageSettings`). */
export function adminSettingsQueryOptions() {
  return queryOptions({
    queryKey: qk.adminSettings(),
    queryFn: async () => unwrap(await api.api.admin.settings.get()),
  })
}

export interface AdminSettingsUpdateInput {
  defaultScanIntervalMinutes?: number
  retentionScansPerProject?: number
  retentionDeliveryDays?: number
}

export function useUpdateAdminSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (patch: AdminSettingsUpdateInput) =>
      unwrap(await api.api.admin.settings.patch(patch)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.adminSettings() })
    },
  })
}
