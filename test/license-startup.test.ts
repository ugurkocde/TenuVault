import { licenseStatusHandler } from "../src/main/license/status"
import type { LicenseStatus } from "../src/shared/ipc"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { LicenseService } from "../src/main/license/service"
import { memoryStore } from "./helpers"
const contract = JSON.parse(readFileSync(join(__dirname, "fixtures/license-contract.json"), "utf8"))

describe("startup license checks", () => {
  it("does not defer an empty startup refresh notification behind trial health", async () => {
    let finishHealth!: (value: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finishHealth = resolve }))
    const onChange = vi.fn()
    const license = new LicenseService({ store: memoryStore(), persist: true, publicKey: contract.publicKey, apiBase: "https://www.tenuvault.com", appVersion: "0.5.0", fetch: fetch as typeof globalThis.fetch, onChange })
    let settled = false
    const refresh = license.refreshAll().then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    const startupSettled = settled
    finishHealth?.(Response.json({ tenantTrials: { enabled: false, ok: true } }))
    await refresh
    expect(startupSettled).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledOnce()
  })
  it("does not request trial health before loading a saved key", async () => {
    const store = memoryStore()
    store.set("license.state", JSON.stringify({ key: "SAVED-LICENSE-KEY", activations: {} }))
    const fetch = vi.fn(async () => { throw new Error("offline") })
    const license = new LicenseService({ store, persist: true, publicKey: contract.publicKey, apiBase: "https://www.tenuvault.com", appVersion: "0.5.0", fetch: fetch as typeof globalThis.fetch })
    await license.checkTrialHealth()
    expect(fetch).not.toHaveBeenCalled()
    expect(license.status([]).hasKey).toBe(true)
  })
  it("keeps a saved key and its cached activation when startup refresh fails", async () => {
    const store = memoryStore()
    const fixture = contract.tokens.find((entry: { name: string }) => entry.name === "v1 pro")
    store.set("license.installId", contract.installId)
    store.set("license.state", JSON.stringify({ key: "SAVED-LICENSE-KEY", activations: { [contract.tenantId]: { activationId: fixture.payload.act, token: fixture.token } } }))
    const fetch = vi.fn(async (_url: unknown) => { throw new TypeError("fetch failed") })
    const license = new LicenseService({ store, persist: true, publicKey: contract.publicKey, apiBase: "https://www.tenuvault.com", appVersion: "0.5.0", fetch: fetch as typeof globalThis.fetch })
    await license.refreshAll()
    await license.checkTrialHealth()
    expect(fetch).toHaveBeenCalledOnce()
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/refresh")
    expect(license.status([contract.tenantId])).toMatchObject({ hasKey: true, offline: true, tenants: [{ activated: true }] })
    expect(JSON.parse(store.get("license.state")!).activations[contract.tenantId].token).toBe(fixture.token)
  })

  it("shares an in-flight health response and publishes trial readiness", async () => {
    let finishHealth!: (value: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finishHealth = resolve }))
    const onChange = vi.fn()
    const license = new LicenseService({ store: memoryStore(), persist: true, publicKey: contract.publicKey, apiBase: "https://www.tenuvault.com", appVersion: "0.5.0", fetch: fetch as typeof globalThis.fetch, onChange })
    let settled = false
    const first = license.checkTrialHealth()
    const second = license.checkTrialHealth().then(() => { settled = true })
    await license.refreshAll()
    expect(settled).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledOnce()
    finishHealth(Response.json({ tenantTrials: { enabled: true, ok: true } }))
    await Promise.all([first, second])
    expect(license.status([]).tenantTrialsEnabled).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("returns cached IPC status immediately while health is pending", async () => {
    let finish!: () => void
    const checkTrialHealth = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const cached: LicenseStatus = { hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: null, tenantLimit: null, validUntil: null, communityTenantId: null, tenants: [] }
    const handler = licenseStatusHandler({ checkTrialHealth }, () => cached)
    expect(handler()).toBe(cached)
    expect(checkTrialHealth).toHaveBeenCalledOnce()
    finish()
    await new Promise(resolve => setImmediate(resolve))
  })
  it("keeps the status error when the independent health read also fails", async () => {
    const handler = licenseStatusHandler({ checkTrialHealth: async () => { throw new Error("health unavailable") } }, () => { throw new Error("status unavailable") })
    expect(handler).toThrow("status unavailable")
    await new Promise(resolve => setImmediate(resolve))
  })

})
