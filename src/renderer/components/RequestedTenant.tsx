import { useEffect, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"

/** Resolve notification links before a service guard or a workflow reads the selected tenant. */
export function RequestedTenant({ children }: { children: ReactNode }) {
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const tenants = useTenants()
  const [params] = useSearchParams()
  const requested = params.get("tenant")?.toLowerCase()
  const match = requested ? tenants.find(tenant => tenant.credentials?.tenantId.toLowerCase() === requested) : undefined
  const changing = Boolean(match && match.id !== selectedTenant?.id)
  useEffect(() => {
    if (changing && match) setSelectedTenantId(match.id)
  }, [changing, match?.id, setSelectedTenantId])
  if (changing) return <p role="status" className="p-6 text-sm text-gray-600">Selecting the requested tenant...</p>
  return children
}
