import { useQueries, useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"

export function useReadOnlyRegistration(tenant: Tenant | null | undefined): boolean {
  return useRegistrationAccess(tenant?.credentials?.tenantId, tenant?.credentials?.appId)
}

export function useRegistrationAccess(tenantId?: string, clientId?: string): boolean {
  return useQuery(registrationStatus(tenantId, clientId)).data?.readOnlyRegistration === true
}

function registrationStatus(tenantId?: string, clientId?: string) {
  return {
    queryKey: ["services-status", tenantId, clientId],
    queryFn: async () => {
      const { bridge } = await import("./bridge")
      return bridge.services.status(tenantId!, clientId!)
    },
    enabled: Boolean(tenantId && clientId),
    staleTime: 60_000,
    retry: false,
  }
}

/** Use the same cached token check for each destination in a multi-tenant workflow. */
export function useReadOnlyTenants(tenants: Tenant[], enabled = true): ReadonlySet<string> {
  const results = useQueries({ queries: enabled ? tenants.flatMap(({ credentials }) =>
    credentials ? [registrationStatus(credentials.tenantId, credentials.appId)] : []) : [] })
  return new Set(results.flatMap(({ data }) => data?.readOnlyRegistration ? [data.tenantId.toLowerCase()] : []))
}
