import { queryOptions, useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import type { OptionalPermissionId, OptionalPermissionStatus } from "../../../shared/services/optional-permissions"

export interface PermissionTenant {
  tenantId: string
  appId: string
}

export const servicesStatusKey = (tenantId?: string, appId?: string) => ["services-status", tenantId, appId] as const

export function servicesStatusOptions(tenant?: PermissionTenant | null) {
  return queryOptions({
    queryKey: servicesStatusKey(tenant?.tenantId, tenant?.appId),
    queryFn: async () => {
      const { bridge } = await import("../../lib/bridge")
      return bridge.services.status(tenant!.tenantId, tenant!.appId)
    },
    enabled: Boolean(tenant?.tenantId && tenant?.appId),
    staleTime: 60_000,
    retry: false,
  })
}

export function useOptionalPermission(tenant: Tenant | PermissionTenant | null, id: OptionalPermissionId): OptionalPermissionStatus | null {
  const credentials = tenant && ("tenantId" in tenant ? tenant : tenant.credentials)
  const query = useQuery(servicesStatusOptions(credentials))
  return query.data?.optional?.find(entry => entry.id === id) ?? null
}
