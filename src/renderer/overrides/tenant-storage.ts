import { bridge } from "../lib/bridge"

/**
 * Desktop replacement for ~/lib/tenant-storage.
 *
 * Tenant profiles persist across restarts in the main process's OS-encrypted store
 * instead of browser session storage. Desktop profiles hold no secrets (see
 * DELEGATED_CLIENT_SECRET); profiles created by the onboarding wizard for the unattended
 * backup app registration are protected by DPAPI or the macOS Keychain.
 *
 * When a tenant disappears from the list, its license activation is released, which frees
 * its tenant slot on the license, and its sign-in and schedule are removed. At startup,
 * activations of sign-ins that never became a saved tenant (for example when the admin
 * cancelled the resource picker), or whose release failed, are released as well.
 */

const TENANTS_KEY = "tenuvault_tenants"

function tenantIds(serialized: string | null): Set<string> | null {
  if (serialized === null || serialized === "") return new Set()
  try {
    const tenants = JSON.parse(serialized) as Array<{ credentials?: { tenantId?: string } }>
    if (!Array.isArray(tenants) || tenants.some((tenant) =>
      !tenant || typeof tenant !== "object" || Array.isArray(tenant) ||
      (tenant.credentials !== undefined && (
        !tenant.credentials || typeof tenant.credentials !== "object" || Array.isArray(tenant.credentials) ||
        typeof tenant.credentials.tenantId !== "string" || !tenant.credentials.tenantId.trim()
      ))
    )) throw new Error("Stored tenant list has an invalid shape")
    return new Set(tenants.map((t) => t.credentials?.tenantId?.toLowerCase()).filter((id): id is string => Boolean(id)))
  } catch (error) {
    console.error("Could not read the stored tenant list. Tenant activations were kept:", error)
    return null
  }
}

const cache = new Map<string, string | null>()
let preservationWarningShown = false

async function releaseOrphanedTenants(saved: Set<string>): Promise<void> {
  const status = await bridge.license.status()
  for (const { tenantId } of status.tenants.filter((tenant) => tenant.activated)) {
    if (!saved.has(tenantId)) await bridge.license.releaseTenant(tenantId)
  }
}

export const tenantStorage = {
  getItem(key: string): string | null {
    if (!cache.has(key)) {
      const value = bridge.storage.getItemSync(key)
      cache.set(key, value)
      if (key === TENANTS_KEY) {
        const saved = tenantIds(value)
        if (saved) void releaseOrphanedTenants(saved).catch((error) => console.error("Could not release orphaned tenants:", error))
      }
    }
    return cache.get(key) ?? null
  },
  setItem(key: string, value: string): void {
    if (key === TENANTS_KEY) {
      const next = tenantIds(value)
      const previous = tenantIds(tenantStorage.getItem(key))
      if (previous === null && next && (value === "" || (JSON.parse(value) as unknown[]).length === 0)) {
        if (!preservationWarningShown) {
          console.error("The saved tenant list is being preserved for recovery. An empty replacement was not saved.")
          preservationWarningShown = true
        }
        return
      }
      if (next && previous) for (const id of previous) {
        if (!next.has(id)) void bridge.license.releaseTenant(id).catch((error) => console.error("Could not release removed tenant:", error))
      }
    }
    cache.set(key, value)
    void bridge.storage.setItem(key, value)
  },
  removeItem(key: string): void {
    cache.set(key, null)
    void bridge.storage.removeItem(key)
  },
}
