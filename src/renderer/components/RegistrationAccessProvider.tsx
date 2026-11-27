import { useQueries } from "@tanstack/react-query"
import { useMemo, type ReactNode } from "react"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { bridge } from "../lib/bridge"
import { tenantLicense, useLicense } from "../lib/license"
import { RegistrationAccessContext } from "../lib/registration-access"

export function RegistrationAccessProvider({ children }: { children: ReactNode }) {
  const tenants = useTenants()
  const { selectedTenant } = useSelectedTenant()
  const { status } = useLicense()
  const results = useQueries({
    queries: tenants.flatMap(({ credentials }) => {
      if (!credentials || !tenantLicense(status, credentials.tenantId)?.signedIn) return []
      const { tenantId, appId } = credentials
      return [{
        queryKey: ["services-status", tenantId, appId],
        queryFn: () => bridge.services.status(tenantId, appId),
        staleTime: 60_000,
        retry: false,
      }]
    }),
    combine: results => results.flatMap(({ data }) => data?.readOnlyRegistration ? [data.tenantId.toLowerCase()] : []),
  })
  const readOnlyTenants = useMemo(() => new Set(results), [results])
  const selectedReadOnly = readOnlyTenants.has(selectedTenant?.credentials?.tenantId.toLowerCase() ?? "")
  const value = useMemo(() => ({ readOnlyTenants, selectedReadOnly }), [readOnlyTenants, selectedReadOnly])
  return <RegistrationAccessContext.Provider value={value}>{children}</RegistrationAccessContext.Provider>
}
