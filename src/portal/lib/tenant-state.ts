import type { Tenant } from "~/contexts/TenantContext"

const TRANSIENT_TENANT_FIELDS = ["isLoading", "syncStatus"] as const

function stripTransientTenantFields(tenant: Tenant): Tenant {
  const result = { ...tenant }
  for (const field of TRANSIENT_TENANT_FIELDS) {
    if (field === "syncStatus") {
      if (result[field] === "pending") result[field] = "idle"
    } else {
      delete result[field]
    }
  }
  return result
}

export function deserializeTenants(stored: string): Tenant[] {
  return (JSON.parse(stored) as Tenant[]).map(tenant => {
    const result = stripTransientTenantFields(tenant)
    if (tenant.credentials) {
      let clientSecret = tenant.credentials.clientSecret
      try {
        clientSecret = atob(clientSecret)
      } catch {
        // Older profiles may contain an unencoded secret.
      }
      result.credentials = { ...tenant.credentials, clientSecret }
    }
    return result
  })
}

export function serializeTenants(tenants: Tenant[]): string {
  return JSON.stringify(tenants.map(tenant => ({
    ...stripTransientTenantFields(tenant),
    credentials: tenant.credentials ? {
      ...tenant.credentials,
      clientSecret: btoa(tenant.credentials.clientSecret)
    } : undefined
  })))
}

export type TenantSyncTimers = Map<number, ReturnType<typeof setTimeout>>

export function scheduleTenantSync(timers: TenantSyncTimers, tenantId: number, sync: () => void): void {
  const previous = timers.get(tenantId)
  if (previous !== undefined) clearTimeout(previous)
  timers.set(tenantId, setTimeout(() => {
    timers.delete(tenantId)
    sync()
  }, 2000))
}

export function clearTenantSyncTimers(timers: TenantSyncTimers): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}
