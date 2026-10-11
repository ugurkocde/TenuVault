import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../src/portal/contexts/TenantContext"
import { clearTenantSyncTimers, deserializeTenants, scheduleTenantSync, serializeTenants, type TenantSyncTimers } from "../src/portal/lib/tenant-state"

function tenant(id: number, updates: Partial<Tenant> = {}): Tenant {
  return {
    id, name: `Tenant ${id}`, domain: "example.com", status: "healthy",
    lastBackup: "2026-10-10T12:00:00Z", configCount: 2, storageUsed: "1 MB",
    client: "", license: "", region: "", tags: ["Production"], users: 3,
    devices: 4, complianceRate: 100, industry: "", environment: "",
    lastSync: "2026-10-10T12:00:00Z", syncStatus: "idle",
    policies: { compliance: 1, configuration: 1, apps: 0 },
    credentials: { tenantId: `tenant-${id}`, appId: "app-id", clientSecret: "test-secret" },
    ...updates
  }
}

afterEach(() => vi.useRealTimers())

describe("tenant profile persistence", () => {
  it("resets interrupted backup and refresh flags when loading older profiles", () => {
    const profiles = [tenant(1, { isLoading: true, syncStatus: "pending" }), tenant(2, { isLoading: true })]
    const stored = profiles.map(profile => ({
      ...profile,
      credentials: { ...profile.credentials!, clientSecret: btoa(profile.credentials!.clientSecret) }
    }))

    const loaded = deserializeTenants(JSON.stringify(stored))

    expect(loaded).toEqual(profiles.map(profile => {
      const { isLoading: _isLoading, ...persistent } = profile
      return { ...persistent, syncStatus: "idle" }
    }))
    expect(loaded.every(profile => !profile.isLoading && profile.syncStatus !== "pending")).toBe(true)
  })

  it("does not save in-flight flags or mutate the active tenant", () => {
    const active = tenant(1, { isLoading: true, syncStatus: "pending" })
    const saved = JSON.parse(serializeTenants([active])) as Tenant[]

    expect(saved[0]).not.toHaveProperty("isLoading")
    expect(saved[0]?.syncStatus).toBe("idle")
    expect(saved[0]?.credentials?.clientSecret).toBe(btoa("test-secret"))
    expect(deserializeTenants(serializeTenants([active]))[0]).toMatchObject({
      tags: active.tags, lastBackup: active.lastBackup, lastSync: active.lastSync,
      policies: active.policies, credentials: active.credentials
    })
    expect(active).toMatchObject({ isLoading: true, syncStatus: "pending" })
  })

  it.each(["idle", "success", "error"])("preserves the settled sync status %s", syncStatus => {
    const profile = tenant(1, { syncStatus })
    expect(deserializeTenants(serializeTenants([profile]))).toEqual([profile])
  })

  it("loads a profile without credentials and preserves an unencoded legacy secret", () => {
    expect(deserializeTenants(JSON.stringify([tenant(1, { credentials: undefined }), tenant(2)])))
      .toEqual([tenant(1, { credentials: undefined }), tenant(2)])
  })
})

describe("per-tenant metadata sync debounce", () => {
  it("syncs all three tenants updated in quick succession once each", () => {
    vi.useFakeTimers()
    const timers: TenantSyncTimers = new Map()
    const sync = vi.fn()
    for (const id of [1, 2, 3]) {
      scheduleTenantSync(timers, id, () => sync(id))
      vi.advanceTimersByTime(100)
    }

    expect(sync).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)

    expect(sync.mock.calls).toEqual([[1], [2], [3]])
    expect(timers.size).toBe(0)
  })

  it("debounces repeated updates only for the same tenant", () => {
    vi.useFakeTimers()
    const timers: TenantSyncTimers = new Map()
    const sync = vi.fn()
    scheduleTenantSync(timers, 1, () => sync(1, "old"))
    scheduleTenantSync(timers, 2, () => sync(2, "other"))
    vi.advanceTimersByTime(1000)
    scheduleTenantSync(timers, 1, () => sync(1, "latest"))

    vi.advanceTimersByTime(1000)
    expect(sync.mock.calls).toEqual([[2, "other"]])
    vi.advanceTimersByTime(1000)
    expect(sync.mock.calls).toEqual([[2, "other"], [1, "latest"]])
    expect(timers.size).toBe(0)
  })

  it("cancels every pending sync on cleanup", () => {
    vi.useFakeTimers()
    const timers: TenantSyncTimers = new Map()
    const sync = vi.fn()
    for (const id of [1, 2, 3]) scheduleTenantSync(timers, id, sync)

    clearTenantSyncTimers(timers)
    vi.advanceTimersByTime(2000)

    expect(sync).not.toHaveBeenCalled()
    expect(timers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
