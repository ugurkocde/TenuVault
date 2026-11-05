import { useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import type { OptionalPermissionId, OptionalPermissionStatus } from "../../../shared/services/optional-permissions"

/**
 * Whether the signed-in token carries an optional permission, read like Settings > Services
 * and permissions does. Null while loading or when it cannot be read, so nothing is blocked.
 * The bridge is loaded on first use, so screens that never ask stay free of it.
 */
export function useOptionalPermission(tenant: Tenant, id: OptionalPermissionId): OptionalPermissionStatus | null {
  const tenantId = tenant.credentials?.tenantId
  const clientId = tenant.credentials?.appId
  const query = useQuery({
    queryKey: ["services-status", tenantId, clientId],
    queryFn: async () => {
      const { bridge } = await import("../../lib/bridge")
      return bridge.services.status(tenantId!, clientId!)
    },
    enabled: Boolean(tenantId && clientId),
    // Short, and refreshed by Settings > Services and permissions after a fresh check.
    staleTime: 60_000,
    retry: false,
  })
  return query.data?.optional?.find((entry) => entry.id === id) ?? null
}
