import { generateKeyPairSync, sign } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { requireSourceTenant } from "../src/main/features/promotion/targets"
import { routes } from "../src/main/features/sync"
import { sameLicense } from "../src/main/license/same-license"
import { LicenseService } from "../src/main/license/service"
import { upgradeMessage } from "../src/shared/plans"
import { call, fakeDeps, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"
import { memoryStore } from "./helpers"

const INSTALL = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f"
const KEY = "LICENSE-KEY-FIRST"
const START = Date.UTC(2026, 10, 10)
const DAY = 86_400_000
const TRIAL_LENGTH = 14 * DAY
const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const named = (ids: string[]) => ids.map((tenantId) => ({ tenantId }))

function grant(tenantId: string, source: "trial" | "key", endsAt: number) {
  const trial = source === "trial"
  const id = tenantId.replaceAll("-", "")
  const activationId = trial ? `trial-${id}` : `key-${tenantId}`
  const payload = {
    v: 2,
    sub: trial ? `trial:${id.slice(0, 16)}` : KEY,
    act: activationId,
    plan: "pro",
    tenants: 2,
    tenantId,
    installId: INSTALL,
    status: "granted",
    iat: Date.now() / 1000,
    exp: endsAt / 1000,
    ...(trial ? { trial: true, keyExp: endsAt / 1000 } : {}),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const token = `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`
  // C joins a trial started by another installation.
  return Response.json({
    token,
    activationId,
    source,
    ...(trial ? { trial: true, keyExp: payload.keyExp, canEnd: tenantId !== TENANT_C } : {}),
  })
}

function setup(tenants: string[]) {
  const store = memoryStore()
  store.set("license.installId", INSTALL)
  const trialEnds = new Map<string, number>([[TENANT_C, START + TRIAL_LENGTH - DAY]])
  const license = new LicenseService({
    store,
    persist: true,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    apiBase: "https://www.tenuvault.com",
    appVersion: "0.5.0",
    initialTenantIds: [],
    connectedTenantIds: () => tenants,
    idToken: async (tenantId) => tenantId,
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname.split("/").at(-1)
      if (path === "health") return Response.json({ tenantTrials: { enabled: true, ok: true } })
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.installId).toBe(INSTALL)
      if (path === "activate" && body.key === KEY) {
        if (body.tenantId === TENANT_B) return grant(TENANT_B, "key", Date.now() + TRIAL_LENGTH)
        return Response.json({ reason: "tenant_not_licensed" }, { status: 403 })
      }
      if (path === "tenant" && typeof body.idToken === "string") {
        const tenant = body.idToken
        if (body.action === "activate") return Response.json({ reason: "tenant_not_licensed" }, { status: 403 })
        if (body.action === "start_trial" || body.action === "refresh") {
          const end = trialEnds.get(tenant) ?? Date.now() + TRIAL_LENGTH
          if (Date.now() >= end) return Response.json({ reason: "expired" }, { status: 403 })
          trialEnds.set(tenant, end)
          return grant(tenant, "trial", end)
        }
      }
      throw new Error(`Unexpected licensing request: ${path} ${String(body.action ?? "")}`)
    },
  })
  const deps = fakeDeps({
    plans: Object.fromEntries(tenants.map((tenantId) => [tenantId, "pro"])),
    plan: (tenantId) => license.requireEntitlement(tenantId),
    sameLicense: (a, b) => sameLicense(license.status([]).tenants, a, b),
  })
  const sync = routes(deps)
  const post = (body: Record<string, unknown>) => call(sync, "/api/sync", { tenantId: TENANT_A, ...body })
  const startTrials = async (...ids: string[]) => {
    await license.checkTrialHealth()
    for (const id of ids) await expect(license.checkNewTenant(id)).resolves.toBe("pro")
  }
  const promotionSource = async () => requireSourceTenant({
    tenantId: TENANT_A,
    plan: await deps.plan(TENANT_A),
    deps,
    targetTenants: [TENANT_B],
  }, TENANT_B, { distinct: true })
  return { license, deps, post, startTrials, promotionSource }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(START)
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("Sync with LicenseService trial activations", () => {
  it("offers both trial tenants for single-target Sync and accepts a trial source for promotion", async () => {
    const { license, post, startTrials, promotionSource } = setup([TENANT_A, TENANT_B, TENANT_C])
    await startTrials(TENANT_A, TENANT_B, TENANT_C)
    const { hasKey, tenants } = license.status([])
    expect(hasKey).toBe(false)
    expect(tenants).toMatchObject([
      { tenantId: TENANT_A, entitled: true, source: "trial", canEnd: true },
      { tenantId: TENANT_B, entitled: true, source: "trial", canEnd: true },
      { tenantId: TENANT_C, entitled: true, source: "trial", canEnd: false },
    ])

    expect(await post({ action: "targets" })).toEqual({
      status: 200,
      body: {
        multiple: false,
        targets: [
          { tenantId: TENANT_B, eligible: true, multiple: false, reason: null },
          { tenantId: TENANT_C, eligible: true, multiple: false, reason: null },
        ],
      },
    })
    expect(await post({ action: "status", targetTenants: named([TENANT_B]) })).toEqual({
      status: 200,
      body: { targets: [{ targetTenantId: TENANT_B, links: [], error: null }] },
    })
    await expect(promotionSource()).resolves.toBe(TENANT_B)
  })

  it.each([
    { action: "plan", title: "Sync policies", items: [{ sourceId: "policy-1", folder: "ConfigurationPolicies" }] },
    { action: "status" },
  ])("requires MSP for Sync $action with two trial targets", async (request) => {
    const { post, startTrials } = setup([TENANT_A, TENANT_B, TENANT_C])
    await startTrials(TENANT_A, TENANT_B, TENANT_C)

    expect(await post({ ...request, targetTenants: named([TENANT_B, TENANT_C]) })).toEqual({
      status: 402,
      body: { error: upgradeMessage("bulkActions"), upgrade: "bulkActions" },
    })
  })

  it("refuses to pair a trial tenant with a key-covered tenant for Sync or promotion", async () => {
    const { license, post, startTrials, promotionSource } = setup([TENANT_A, TENANT_B])
    await startTrials(TENANT_A)
    await license.setKey(KEY, [TENANT_B])
    expect(license.status([]).tenants).toMatchObject([
      { tenantId: TENANT_A, entitled: true, plan: "pro", source: "trial" },
      { tenantId: TENANT_B, entitled: true, plan: "pro", source: "key" },
    ])

    expect(await post({ action: "targets" })).toEqual({
      status: 200,
      body: { multiple: false, targets: [{ tenantId: TENANT_B, eligible: false, multiple: false, reason: "msp" }] },
    })
    expect(await post({ action: "status", targetTenants: named([TENANT_B]) })).toEqual({
      status: 402,
      body: { error: upgradeMessage("bulkActions"), upgrade: "bulkActions" },
    })
    await expect(promotionSource()).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("covered by the same license"),
    })
  })

  it("stops pairing a target when its trial token expires", async () => {
    const { license, deps, post, startTrials } = setup([TENANT_A, TENANT_B])
    await startTrials(TENANT_B)
    vi.setSystemTime(START + DAY)
    await startTrials(TENANT_A)
    expect(deps.sameLicense(TENANT_A, TENANT_B)).toBe(true)

    vi.setSystemTime(START + TRIAL_LENGTH)
    expect(license.status([]).tenants.find((tenant) => tenant.tenantId === TENANT_B)).toMatchObject({
      activated: true,
      entitled: false,
      coverageEnded: true,
    })
    expect(deps.sameLicense(TENANT_A, TENANT_B)).toBe(false)
    const response = await post({ action: "targets" })
    expect(response.status).toBe(200)
    expect(response.body.targets).toMatchObject([{ tenantId: TENANT_B, eligible: false, multiple: false }])
  })
})
