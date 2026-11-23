import { createContext, useContext } from "react"
import type { Tenant } from "~/contexts/TenantContext"

export const RegistrationAccessContext = createContext<{
  readOnlyTenants: ReadonlySet<string>
  selectedReadOnly: boolean
}>({ readOnlyTenants: new Set(), selectedReadOnly: false })

export function useReadOnlyRegistration(tenant: Tenant | null | undefined): boolean {
  return useRegistrationAccess(tenant?.credentials?.tenantId)
}

export function useRegistrationAccess(tenantId?: string): boolean {
  return useReadOnlyTenants().has(tenantId?.toLowerCase() ?? "")
}

export function useReadOnlyTenants(): ReadonlySet<string> {
  return useContext(RegistrationAccessContext).readOnlyTenants
}

export function useSelectedRegistrationAccess(): boolean {
  return useContext(RegistrationAccessContext).selectedReadOnly
}
