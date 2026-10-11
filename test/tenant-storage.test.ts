import { setImmediate } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const bridge = vi.hoisted(() => ({
  storage: {
    getItemSync: vi.fn<(key: string) => string | null>(),
    setItem: vi.fn(async (_key: string, _value: string) => {}),
    removeItem: vi.fn(async (_key: string) => {}),
  },
  license: {
    status: vi.fn(async () => ({ tenants: [
      { tenantId: "saved-tenant", activated: true },
      { tenantId: "orphaned-tenant", activated: true },
      { tenantId: "inactive-tenant", activated: false },
    ] })),
    releaseTenant: vi.fn(async (_tenantId: string) => {}),
  },
}))

vi.mock("../src/renderer/lib/bridge", () => ({ bridge }))

const TENANTS_KEY = "tenuvault_tenants"

describe("tenantStorage", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    bridge.storage.getItemSync.mockReturnValue(null)
    bridge.storage.setItem.mockImplementation(async (_key: string, _value: string) => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it("releases activated tenants when no list has been stored", async () => {
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    await setImmediate()

    expect(bridge.license.status).toHaveBeenCalledOnce()
    expect(bridge.license.releaseTenant.mock.calls).toEqual([["saved-tenant"], ["orphaned-tenant"]])
    expect(console.error).not.toHaveBeenCalled()
  })

  it("keeps saved tenants and releases only activated orphans once per cached read", async () => {
    const stored = JSON.stringify([{ credentials: { tenantId: "SAVED-TENANT" } }, { id: 1, name: "No credentials" }])
    bridge.storage.getItemSync.mockReturnValue(stored)
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(tenantStorage.getItem(TENANTS_KEY)).toBe(stored)
    expect(tenantStorage.getItem(TENANTS_KEY)).toBe(stored)
    await setImmediate()

    expect(bridge.storage.getItemSync).toHaveBeenCalledOnce()
    expect(bridge.license.status).toHaveBeenCalledOnce()
    expect(bridge.license.releaseTenant).toHaveBeenCalledExactlyOnceWith("orphaned-tenant")
  })

  it.each(["[]", ""])("releases activated tenants for empty storage: %s", async (stored) => {
    bridge.storage.getItemSync.mockReturnValue(stored)
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    tenantStorage.getItem(TENANTS_KEY)
    await setImmediate()

    expect(bridge.license.status).toHaveBeenCalledOnce()
    expect(bridge.license.releaseTenant.mock.calls).toEqual([["saved-tenant"], ["orphaned-tenant"]])
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([
    "{broken", "null", "{}", '"tenants"', "42", "[null]", "[1]", "[[]]",
    '[{"credentials":null}]', '[{"credentials":[]}]', '[{"credentials":{}}]',
    '[{"credentials":{"tenantId":42}}]', '[{"credentials":{"tenantId":" "}}]',
    '[{"credentials":{"tenantId":"saved-tenant"}},null]',
  ])("keeps activations when the stored list is unreadable: %s", async (stored) => {
    bridge.storage.getItemSync.mockReturnValue(stored)
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    await setImmediate()

    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(
      "Could not read the stored tenant list. Tenant activations were kept:", expect.any(Error),
    )
  })

  it.each(["status", "releaseTenant"] as const)("handles a rejected startup %s without an unhandled rejection", async (operation) => {
    const error = new Error("Release failed")
    bridge.license[operation].mockRejectedValueOnce(error)
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    try {
      const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

      expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
      await setImmediate()

      expect(unhandled).not.toHaveBeenCalled()
      expect(console.error).toHaveBeenCalledWith("Could not release orphaned tenants:", error)
    } finally {
      process.off("unhandledRejection", unhandled)
    }
  })

  it("releases a removed tenant and handles a rejected release", async () => {
    bridge.storage.getItemSync.mockReturnValue(JSON.stringify([
      { credentials: { tenantId: "saved-tenant" } }, { credentials: { tenantId: "orphaned-tenant" } },
    ]))
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")
    tenantStorage.getItem(TENANTS_KEY)
    await setImmediate()
    const error = new Error("Release failed")
    bridge.license.releaseTenant.mockRejectedValueOnce(error)

    const next = JSON.stringify([{ credentials: { tenantId: "saved-tenant" } }])
    tenantStorage.setItem(TENANTS_KEY, next)
    await setImmediate()

    expect(bridge.license.releaseTenant).toHaveBeenCalledExactlyOnceWith("orphaned-tenant")
    expect(console.error).toHaveBeenCalledWith("Could not release removed tenant:", error)
    expect(bridge.storage.setItem).toHaveBeenCalledWith(TENANTS_KEY, next)
  })

  it("does not release tenants when a replacement list is unreadable", async () => {
    bridge.storage.getItemSync.mockReturnValue(JSON.stringify([{ credentials: { tenantId: "saved-tenant" } }]))
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")
    tenantStorage.getItem(TENANTS_KEY)
    await setImmediate()
    bridge.license.releaseTenant.mockClear()

    tenantStorage.setItem(TENANTS_KEY, "{}")
    await setImmediate()

    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()
  })

  it.each(["[]", " [ ] ", "", "[{}]", '[{"id":1,"name":"No credentials"}]'])("preserves an unreadable list instead of saving a value without tenant ids: %s", async (value) => {
    bridge.storage.getItemSync.mockReturnValue("{broken")
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    tenantStorage.setItem(TENANTS_KEY, value)
    tenantStorage.setItem(TENANTS_KEY, value)
    await setImmediate()

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    expect(bridge.storage.setItem).not.toHaveBeenCalled()
    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ["Could not read the stored tenant list. Tenant activations were kept:", expect.any(Error)],
      ["The saved tenant list is being preserved for recovery. An empty replacement was not saved."],
    ])
  })

  it("keeps the corrupt stored list and activations after an empty save and a restart", async () => {
    const corrupt = "{broken"
    let stored = corrupt
    bridge.storage.getItemSync.mockImplementation(() => stored)
    bridge.storage.setItem.mockImplementation(async (_key, value) => { stored = value })
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    tenantStorage.setItem(TENANTS_KEY, "[]")
    await setImmediate()

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    expect(stored).toBe(corrupt)
    vi.resetModules()
    const { tenantStorage: restartedStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(restartedStorage.getItem(TENANTS_KEY)).toBeNull()
    await setImmediate()

    expect(stored).toBe(corrupt)
    expect(bridge.storage.setItem).not.toHaveBeenCalled()
    expect(bridge.storage.getItemSync).toHaveBeenCalledTimes(2)
    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()
  })

  it.each(["[1]", "[[]]"])("preserves an unreadable array after a context save and a restart: %s", async (corrupt) => {
    let stored = corrupt
    bridge.storage.getItemSync.mockImplementation(() => stored)
    bridge.storage.setItem.mockImplementation(async (_key, value) => { stored = value })
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    await setImmediate()
    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()

    tenantStorage.setItem(TENANTS_KEY, "[{}]")
    await setImmediate()

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    expect(stored).toBe(corrupt)
    expect(bridge.storage.setItem).not.toHaveBeenCalled()
    vi.resetModules()
    const { tenantStorage: restartedStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(restartedStorage.getItem(TENANTS_KEY)).toBeNull()
    await setImmediate()

    expect(stored).toBe(corrupt)
    expect(bridge.storage.getItemSync).toHaveBeenCalledTimes(2)
    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()
  })

  it("refuses an unreadable replacement when the stored list is already unreadable", async () => {
    let stored = "{broken"
    bridge.storage.getItemSync.mockImplementation(() => stored)
    bridge.storage.setItem.mockImplementation(async (_key, value) => { stored = value })
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    tenantStorage.setItem(TENANTS_KEY, "{}")
    await setImmediate()

    expect(stored).toBe("{broken")
    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    expect(bridge.storage.setItem).not.toHaveBeenCalled()
    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()
  })

  it("saves a valid list with a tenant id without releasing tenants, then resumes removal cleanup", async () => {
    const next = JSON.stringify([{ credentials: { tenantId: "saved-tenant" } }])
    let stored = "{broken"
    bridge.storage.getItemSync.mockImplementation(() => stored)
    bridge.storage.setItem.mockImplementation(async (_key, value) => { stored = value })
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    tenantStorage.setItem(TENANTS_KEY, next)
    await setImmediate()

    expect(stored).toBe(next)
    expect(tenantStorage.getItem(TENANTS_KEY)).toBe(next)
    expect(bridge.storage.setItem).toHaveBeenCalledExactlyOnceWith(TENANTS_KEY, next)
    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()

    tenantStorage.setItem(TENANTS_KEY, "[]")
    await setImmediate()

    expect(stored).toBe("[]")
    expect(bridge.license.releaseTenant).toHaveBeenCalledExactlyOnceWith("saved-tenant")
  })

  it("clears the unreadable classification when the stored list is removed", async () => {
    bridge.storage.getItemSync.mockReturnValue("{broken")
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    tenantStorage.removeItem(TENANTS_KEY)
    tenantStorage.setItem(TENANTS_KEY, "[]")
    await setImmediate()

    expect(tenantStorage.getItem(TENANTS_KEY)).toBe("[]")
    expect(bridge.storage.removeItem).toHaveBeenCalledExactlyOnceWith(TENANTS_KEY)
    expect(bridge.storage.setItem).toHaveBeenCalledExactlyOnceWith(TENANTS_KEY, "[]")
    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()
  })

  it("resumes normal cleanup and writes after a recovered file is read on restart", async () => {
    let stored = "{broken"
    bridge.storage.getItemSync.mockImplementation(() => stored)
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(tenantStorage.getItem(TENANTS_KEY)).toBeNull()
    tenantStorage.setItem(TENANTS_KEY, "[]")
    await setImmediate()
    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()

    stored = JSON.stringify([{ credentials: { tenantId: "saved-tenant" } }])
    vi.resetModules()
    const { tenantStorage: restartedStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(restartedStorage.getItem(TENANTS_KEY)).toBe(stored)
    await setImmediate()
    expect(bridge.license.releaseTenant).toHaveBeenCalledExactlyOnceWith("orphaned-tenant")

    restartedStorage.setItem(TENANTS_KEY, "[]")
    await setImmediate()
    expect(restartedStorage.getItem(TENANTS_KEY)).toBe("[]")
    expect(bridge.storage.setItem).toHaveBeenCalledExactlyOnceWith(TENANTS_KEY, "[]")
    expect(bridge.license.releaseTenant.mock.calls).toEqual([["orphaned-tenant"], ["saved-tenant"]])
  })
})
