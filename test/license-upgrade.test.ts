import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LicenseService } from "../src/main/license/service"
import { SecureStore } from "../src/main/storage/secure-store"

// Upgrades must keep the installation and its entitlement. These fixtures are the bytes released
// versions wrote (test/fixtures/license/README.md); every version that can load them must keep
// passing, so the fixtures are never edited, only added.
const FIXTURES = join(__dirname, "fixtures/license")
const identity = {
  encrypt: (text: string) => Buffer.from(text, "utf8"),
  decrypt: (data: Buffer) => data.toString("utf8"),
}

interface Capture {
  app: string
  capturedAt: number
  installId: string
  tenants: Record<"TENANT_A" | "TENANT_B" | "TENANT_ORG" | "TENANT_REMOVED" | "TENANT_COMMUNITY", string>
}

const releases = readdirSync(FIXTURES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)

// The keys of the app-state store the license lives in. Renaming one loses every customer's
// license on upgrade, so they are pinned here as literals.
const STATE_KEYS = ["license.state", "license.installId", "license.removedTenants", "license.communityTenant"]

describe.each(releases)("license state written by %s", (release) => {
  const folder = join(FIXTURES, release)
  const capture = JSON.parse(readFileSync(join(folder, "capture.json"), "utf8")) as Capture
  const hasTenantTrial = release !== "v0.4.2"
  const signer = readFileSync(join(folder, "signer-public-key.txt"), "utf8")
  const { TENANT_A, TENANT_B, TENANT_ORG, TENANT_REMOVED, TENANT_COMMUNITY } = capture.tenants
  let fetchMock: ReturnType<typeof vi.fn>

  // Opens a copy of the fixture with today's SecureStore, as an upgraded app does.
  function open(name: string) {
    const file = join(mkdtempSync(join(tmpdir(), "tv-license-upgrade-")), "app-state.bin")
    copyFileSync(join(folder, `${name}.app-state.bin`), file)
    const store = new SecureStore(file, identity)
    store.open()
    const service = new LicenseService({
      store,
      persist: true,
      publicKey: signer,
      apiBase: "https://www.tenuvault.com",
      appVersion: "99.0.0",
      fetch: fetchMock as unknown as typeof fetch,
    })
    return { store, service }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    // An hour after the old version saved its state, and offline: everything must come from disk.
    vi.setSystemTime(capture.capturedAt * 1000 + 60 * 60_000)
    fetchMock = vi.fn(() => Promise.reject(new TypeError("fetch failed")))
  })
  afterEach(() => vi.useRealTimers())

  it("keeps the store keys the license is saved under", () => {
    const keys = new Set<string>()
    for (const name of ["paid", "trial", "community", ...(hasTenantTrial ? ["tenant-trial"] : [])]) {
      for (const key of Object.keys(JSON.parse(readFileSync(join(folder, `${name}.app-state.bin`), "utf8")) as object)) keys.add(key)
    }
    expect([...keys].sort()).toEqual([...STATE_KEYS, ...(hasTenantTrial ? ["license.tenantTrials"] : [])].sort())
  })

  it("keeps a paid key entitled offline, with the same installation", async () => {
    const { store, service } = open("paid")
    expect(store.get("license.installId")).toBe(capture.installId)
    const status = service.status([TENANT_A, TENANT_B, TENANT_ORG])
    expect(status).toMatchObject({ hasKey: true, keyState: "active", plan: "pro", trial: false, persisted: true })
    const tenant = (id: string) => status.tenants.find((entry) => entry.tenantId === id)
    expect(tenant(TENANT_A)).toMatchObject({ entitled: true, source: "key", shared: true })
    expect(tenant(TENANT_B)).toMatchObject({ entitled: true, source: "key" })
    expect(tenant(TENANT_ORG)).toMatchObject({ entitled: true, source: "tenant", displayKey: "****9F2A" })
    await expect(service.requireEntitlement(TENANT_A)).resolves.toBe("pro")
    await expect(service.requireEntitlement(TENANT_ORG)).resolves.toBe("pro")
    expect(fetchMock).not.toHaveBeenCalled()
    // The installation id the activations are bound to is unchanged after the upgrade.
    expect(store.get("license.installId")).toBe(capture.installId)
  })

  it("keeps a tenant removed before the upgrade unlicensed", () => {
    const { service } = open("paid")
    expect(service.plan(TENANT_REMOVED)).toBeNull()
    expect(service.entitlementToken(TENANT_REMOVED)).toBeNull()
  })

  it("keeps a trial key a trial, with its end date", () => {
    const { service } = open("trial")
    const status = service.status([TENANT_A])
    expect(status).toMatchObject({ keyState: "active", plan: "pro", trial: true })
    expect(Date.parse(status.trialEndsAt!)).toBe((capture.capturedAt + 20 * 86400) * 1000)
    expect(service.trialCheckoutToken()).not.toBeNull()
  })

  it("keeps the Community tenant", async () => {
    const { service } = open("community")
    expect(service.plan(TENANT_COMMUNITY)).toBe("community")
    await expect(service.requireEntitlement(TENANT_COMMUNITY)).resolves.toBe("community")
    expect(service.status([TENANT_COMMUNITY]).communityTenantId).toBe(TENANT_COMMUNITY)
  })

  it.skipIf(!hasTenantTrial)("keeps an extended tenant trial and its local usage tally", async () => {
    const { store, service } = open("tenant-trial")
    expect(store.get("license.installId")).toBe(capture.installId)
    const end = (capture.capturedAt + 18 * 86400) * 1000
    const tally = { dailyBackups: 2, azureBackups: 1, fullRestores: 1, driftReverts: 1 }
    expect(service.status([TENANT_A]).tenants[0]).toMatchObject({
      entitled: true, plan: "pro", source: "trial", trial: true,
      trialEndsAt: new Date(end).toISOString(), trialExtensionUnavailable: true,
      trialCanExtend: false, trialUsageRevision: 5,
    })
    await expect(service.requireEntitlement(TENANT_A)).resolves.toBe("pro")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(store.get("license.tenantTrials")!)[TENANT_A]).toMatchObject({
      extended: true, trialEndsAt: end, tally,
    })
    // Usage is exposed once the service confirms tenant trials are enabled again.
    fetchMock.mockResolvedValueOnce(Response.json({ tenantTrials: { enabled: true, ok: true, days: 14, extensionDays: 14 } }))
    await service.checkTrialHealth()
    expect(service.trialUsageTally(TENANT_A)).toEqual(tally)
    expect(service.trialUsagePeriod(TENANT_A)).toEqual({ since: (capture.capturedAt - 10 * 86400) * 1000, until: end })
  })

  it("writes state the next start reads the same way", async () => {
    const { store, service } = open("paid")
    // Any save, here a refresh that cannot reach the service, keeps the format readable.
    await service.refreshAll()
    const reopened = new LicenseService({ store, persist: true, publicKey: signer, apiBase: "https://www.tenuvault.com", appVersion: "99.0.0", fetch: fetchMock as unknown as typeof fetch })
    expect(reopened.status([TENANT_A]).tenants[0]).toMatchObject({ entitled: true })
    expect(store.get("license.installId")).toBe(capture.installId)
  })
})
