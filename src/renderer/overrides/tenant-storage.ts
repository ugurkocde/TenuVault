import { pendingSignInTenant } from "../lib/onboarding-draft"
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
const cachedTenantIds = new Map<string, Set<string> | null>()
const pendingSaves = new Map<string, Promise<void>>()
let savedTenantIds: Set<string> | null = null
let preservationWarningShown = false

async function releaseOrphanedTenants(saved: Set<string>): Promise<void> {
  const status = await bridge.license.status()
  const resuming = pendingSignInTenant()
  for (const { tenantId } of status.tenants.filter((tenant) => tenant.activated)) {
    if (!saved.has(tenantId.toLowerCase()) && tenantId.toLowerCase() !== resuming) await bridge.license.releaseTenant(tenantId)
  }
}

export const tenantStorage = {
  getItem(key: string): string | null {
    if (!cache.has(key)) {
      const value = bridge.storage.getItemSync(key)
      cache.set(key, value)
      if (key === TENANTS_KEY) {
        const saved = tenantIds(value)
        savedTenantIds = saved
        cachedTenantIds.set(key, saved)
        if (saved) void releaseOrphanedTenants(saved).catch((error) => console.error("Could not release orphaned tenants:", error))
      }
    }
    // Hide unreadable data so the context cannot turn it into a replacement list.
    // Keep the raw value and its classification cached for recovery and the write guard.
    if (key === TENANTS_KEY && cachedTenantIds.get(key) === null) return null
    return cache.get(key) ?? null
  },
  setItem(key: string, value: string): void {
    let next: Set<string> | null | undefined
    if (key === TENANTS_KEY) {
      next = tenantIds(value)
      tenantStorage.getItem(key)
      if (cachedTenantIds.get(key) === null && (next === null || next.size === 0)) {
        if (!preservationWarningShown) {
          console.error("The saved tenant list is being preserved for recovery. An empty replacement was not saved.")
          preservationWarningShown = true
        }
        return
      }
      cachedTenantIds.set(key, next)
    }
    cache.set(key, value)
    const save = bridge.storage.setItem(key, value)
    pendingSaves.set(key, save)
    void save.then(() => {
      if (pendingSaves.get(key) === save) pendingSaves.delete(key)
      if (next === undefined) return
      const previous = savedTenantIds
      savedTenantIds = next
      if (next && previous) for (const id of previous) {
        if (!next.has(id)) void bridge.license.releaseTenant(id).catch((error) => console.error("Could not release removed tenant:", error))
      }
    }, (error) => {
      if (pendingSaves.get(key) === save) {
        pendingSaves.delete(key)
        const saved = bridge.storage.getItemSync(key)
        cache.set(key, saved)
        if (key === TENANTS_KEY) {
          savedTenantIds = tenantIds(saved)
          cachedTenantIds.set(key, savedTenantIds)
        }
      }
      console.error("Could not save desktop storage:", error)
    })
  },
  removeItem(key: string): void {
    pendingSaves.delete(key)
    cache.set(key, null)
    if (key === TENANTS_KEY) {
      savedTenantIds = new Set()
      cachedTenantIds.set(key, savedTenantIds)
    }
    void bridge.storage.removeItem(key)
  },
}
