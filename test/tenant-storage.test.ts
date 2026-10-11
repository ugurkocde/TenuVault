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

  it("releases activated tenants for a valid empty list", async () => {
    bridge.storage.getItemSync.mockReturnValue("[]")
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    tenantStorage.getItem(TENANTS_KEY)
    await setImmediate()

    expect(bridge.license.status).toHaveBeenCalledOnce()
    expect(bridge.license.releaseTenant.mock.calls).toEqual([["saved-tenant"], ["orphaned-tenant"]])
  })

  it.each([
    "{broken", "", "null", "{}", '"tenants"', "42", "[null]", "[1]", "[[]]",
    '[{"credentials":null}]', '[{"credentials":[]}]', '[{"credentials":{}}]',
    '[{"credentials":{"tenantId":42}}]', '[{"credentials":{"tenantId":" "}}]',
    '[{"credentials":{"tenantId":"saved-tenant"}},null]',
  ])("keeps activations when the stored list is unreadable: %s", async (stored) => {
    bridge.storage.getItemSync.mockReturnValue(stored)
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    expect(tenantStorage.getItem(TENANTS_KEY)).toBe(stored)
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

  it("does not release tenants when an unreadable list is replaced", async () => {
    bridge.storage.getItemSync.mockReturnValue("{broken")
    const { tenantStorage } = await import("../src/renderer/overrides/tenant-storage")

    tenantStorage.setItem(TENANTS_KEY, "[]")
    await setImmediate()

    expect(bridge.license.status).not.toHaveBeenCalled()
    expect(bridge.license.releaseTenant).not.toHaveBeenCalled()
  })
})
