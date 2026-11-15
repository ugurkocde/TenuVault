import { useEffect, type ReactNode } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useSelectedTenant, useTenants, useTenantsLoaded } from "~/contexts/TenantContext"

/** Resolve notification links before a service guard or a workflow reads the selected tenant. */
export function RequestedTenant({ children }: { children: ReactNode }) {
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const tenants = useTenants()
  const tenantsLoaded = useTenantsLoaded()
  const [params] = useSearchParams()
  const requested = params.get("tenant")?.toLowerCase()
  const match = requested ? tenants.find(tenant => tenant.credentials?.tenantId.toLowerCase() === requested) : undefined
  const changing = Boolean(match && match.id !== selectedTenant?.id)
  useEffect(() => {
    if (changing && match) setSelectedTenantId(match.id)
  }, [changing, match?.id, setSelectedTenantId])
  if (requested && !tenantsLoaded) return <p role="status" className="p-6 text-sm text-gray-600">Loading connected tenants...</p>
  if (requested && !match) return <section className="mx-auto mt-8 max-w-2xl space-y-4 rounded-3xl bg-card p-6">
    <h1 className="text-2xl font-medium text-gray-900">The linked tenant is not connected</h1>
    <p className="text-sm text-gray-600">Open Tenants to connect it or choose a connected tenant.</p>
    <Link to="/portal/tenants" className="inline-flex rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Open Tenants</Link>
  </section>
  if (changing) return <p role="status" className="p-6 text-sm text-gray-600">Selecting the requested tenant...</p>
  return children
}
