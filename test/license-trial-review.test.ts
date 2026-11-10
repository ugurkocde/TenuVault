import { generateKeyPairSync, sign } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LicenseService } from "../src/main/license/service"
import { memoryStore } from "./helpers"
const A = "11111111-2222-4333-8444-555555555555"
const B = "66666666-7777-4888-8999-aaaaaaaaaaaa"
const INSTALL = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f"
const DAY = 86400_000
const NOW = Date.UTC(2026, 10, 10)
const { publicKey, privateKey } = generateKeyPairSync("ed25519")
let store: ReturnType<typeof memoryStore>
let connected: string[]
let calls: Array<{ path: string; body: Record<string, unknown> }>
let enabled: boolean
let healthOk: boolean
let ends: Record<string, number>
let limit: number
let answer: ((path: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined) | undefined
function granted(tenant: string, source = "trial", key = "key") {
  const activationId = source === "trial" ? `trial-${(tenant === A ? "a" : "b").repeat(32)}` : `${key}-${tenant}`
  const payload = { v: 2, sub: source === "trial" ? "trial:abcdef" : key, act: activationId, plan: "pro", tenants: source === "trial" ? 2 : limit, tenantId: tenant, installId: INSTALL, status: "granted", iat: Date.now() / 1000, exp: source === "trial" ? ends[tenant]! / 1000 : (Date.now() + 30 * DAY) / 1000, ...(source === "trial" ? { trial: true, keyExp: ends[tenant]! / 1000 } : {}) }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return Response.json({ token: `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`, activationId, source, trial: source === "trial", keyExp: ends[tenant]! / 1000, canEnd: true })
}
const refusal = (reason: string, trial = false) => Response.json({ error: trial ? "trial_unavailable" : "The license was not accepted.", reason }, { status: 403 })
function service(version = "0.5.0", initial = [...connected]) {
  return new LicenseService({ store, persist: true, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), apiBase: "https://www.tenuvault.com", appVersion: version, initialTenantIds: initial, connectedTenantIds: () => connected, idToken: async id => id, fetch: (async (url, init) => {
    const path = String(url).split("/").pop()!
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, body })
    const result = answer?.(path, body)
    if (result) return result
    if (path === "health") return Response.json({ tenantTrials: { enabled, ok: healthOk } })
    const tenant = String(body.tenantId ?? body.idToken)
    if (path === "activate" || path === "refresh") return granted(tenant, "key", String(body.key))
    if (path === "deactivate" || body.action === "trial_contact" || body.action === "end_trial") return Response.json({ success: true })
    if (body.action === "activate") return refusal("tenant_not_licensed")
    if (body.action === "refresh" && Date.now() >= ends[tenant]!) return refusal("expired")
    if (body.action === "extend_trial") ends[tenant] = Math.max(ends[tenant]!, Date.now()) + 19 * DAY
    return granted(tenant)
  }) as typeof fetch })
}
async function connect(license: LicenseService, tenant = A) {
  if (!connected.includes(tenant)) connected.push(tenant)
  await license.checkTrialHealth()
  await license.checkNewTenant(tenant)
}
async function flush() { await new Promise(resolve => setImmediate(resolve)) }
const trialRecord = (tenant = A) => JSON.parse(store.get("license.tenantTrials") ?? "{}")[tenant]
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); store = memoryStore(); store.set("license.installId", INSTALL); connected = []; calls = []; enabled = true; healthOk = true; ends = { [A]: NOW + 14 * DAY, [B]: NOW + 14 * DAY }; limit = 2; answer = undefined; vi.spyOn(console, "warn").mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe("trial review regressions", () => {
  it("preserves another tenant's trial across a paid key replacement", async () => {
    const license = service(); await connect(license)
    connected.push(B); limit = 1
    answer = (path, body) => path === "activate" && body.tenantId === A ? refusal("tenant_limit") : undefined
    await license.setKey("LICENSE-KEY-FIRST", [B]); await license.replaceKey("LICENSE-KEY-SECOND", [B])
    expect(license.status(connected).tenants.find(t => t.tenantId === A)).toMatchObject({ entitled: true, source: "trial" })
    expect(calls.filter(c => c.path === "deactivate").some(c => String(c.body.activationId).startsWith("trial-"))).toBe(false)
  })
  it("tries a saved key for a trial omitted from activation targets", async () => {
    const license = service(); await connect(license); connected.push(B)
    await license.setKey("LICENSE-KEY-FIRST", [B]); await license.refreshAll()
    expect(license.status(connected).tenants.find(t => t.tenantId === A)).toMatchObject({ source: "key", trial: false, trialEndsAt: null })
  })
  it.each(["tenant_limit", "network", "server"])("keeps the trial when the paid activation fails with %s", async failure => {
    const license = service(); await connect(license); connected.push(B)
    answer = (path, body) => {
      if (path !== "activate" || body.tenantId !== A) return
      if (failure === "network") throw new TypeError("fetch failed")
      return failure === "server" ? Response.json({ reason: "upstream" }, { status: 503 }) : refusal(failure)
    }
    await license.setKey("LICENSE-KEY-FIRST", [B]); await license.refreshAll()
    expect(license.status(connected).tenants.find(t => t.tenantId === A)).toMatchObject({ source: "trial", entitled: true })
  })
  it.each([undefined, "tenant"])("does not request health for a stored %s activation", async source => {
    connected.push(A)
    const data = await granted(A, "key").json()
    store.set("license.state", JSON.stringify({ activations: { [A]: { activationId: data.activationId, token: data.token, source } } }))
    const license = service(); await license.checkTrialHealth()
    expect(calls).toHaveLength(0)
  })
  it("does not block sign-in on an unresolved health request", async () => {
    let finish!: (response: Response) => void
    answer = path => path === "health" ? new Promise<Response>(resolve => { finish = resolve }) : undefined
    const license = service(); connected.push(A)
    let settled = false
    const check = license.checkNewTenant(A).then(() => { settled = true })
    await flush(); const immediate = settled
    finish(Response.json({ tenantTrials: { enabled: false, ok: true } })); await check
    expect(immediate).toBe(true)
  })
  it("retries failed health with backoff and coalesces requests", async () => {
    let fail = true
    answer = path => path === "health" && fail ? Response.json({}, { status: 503 }) : undefined
    const license = service(); await Promise.all([license.checkTrialHealth(), license.checkTrialHealth()])
    expect(calls).toHaveLength(1)
    await license.checkTrialHealth(); expect(calls).toHaveLength(1)
    fail = false; vi.setSystemTime(NOW + 3 * 60_000); await license.checkTrialHealth()
    expect(calls).toHaveLength(2)
    expect(license.status([]).tenantTrialsEnabled).toBe(true)
    vi.setSystemTime(NOW + 5 * 60_000); await license.checkTrialHealth(); expect(calls).toHaveLength(2)
  })
  it("does not start on a misconfigured enabled server", async () => {
    healthOk = false; const license = service(); await connect(license)
    expect(calls.some(c => c.body.action === "start_trial")).toBe(false)
    expect(license.status(connected).tenantTrialsEnabled).toBe(false)
  })
  it.each(["disabled", "app_update_required"])("keeps the automatic window after %s", async reason => {
    const license = service()
    answer = (_path, body) => body.action === "start_trial" ? refusal(reason, true) : undefined
    await connect(license); expect(trialRecord().stopped).not.toBe(true)
    answer = undefined; vi.setSystemTime(NOW + 7 * 3600_000); await license.refreshAll(); await flush()
    expect(license.status(connected).tenants[0]?.source).toBe("trial")
  })
  it("starts a tenant connected while trials were disabled when the switch enables", async () => {
    enabled = false; const license = service(); await connect(license)
    enabled = true; vi.setSystemTime(NOW + 7 * 3600_000); await license.refreshAll(); await flush()
    expect(license.status(connected).tenants[0]?.source).toBe("trial")
  })
  it.each(["activation_mismatch", "network", "server"])("retains extension after %s", async reason => {
    const license = service(); await connect(license); vi.setSystemTime(NOW + 10 * DAY)
    answer = (_path, body) => {
      if (body.action !== "extend_trial") return
      if (reason === "network") throw new TypeError("fetch failed")
      return reason === "server" ? Response.json({ reason: "storage_unavailable" }, { status: 503 }) : refusal(reason)
    }
    await expect(license.tenantTrialAction(A, "extend_trial")).rejects.toThrow()
    expect(license.status(connected).tenants[0]?.trialCanExtend).toBe(true)
  })
  it("uses the extension response date and gives a specific refusal", async () => {
    const license = service(); await connect(license); vi.setSystemTime(NOW + 10 * DAY)
    answer = (_path, body) => body.action === "extend_trial" ? refusal("used", true) : undefined
    await expect(license.tenantTrialAction(A, "extend_trial")).rejects.toThrow("This trial cannot be extended.")
    expect(license.status(connected).tenants[0]?.trialCanExtend).toBe(false)
  })
  it.each(["remove", "deactivate"])("forgets local trial contact and markers on %s", async action => {
    const license = service(); await connect(license); await license.tenantTrialAction(A, "trial_contact", "admin@contoso.example")
    if (action === "remove") { await license.releaseTenant(A); connected = [] } else await license.deactivate()
    expect(trialRecord()).toBeUndefined()
  })
  it("rejoins a running trial after removal and re-add", async () => {
    const license = service(); await connect(license); await license.releaseTenant(A)
    expect(trialRecord()).toBeUndefined()
    await license.checkNewTenant(A)
    expect(license.status(connected).tenants[0]).toMatchObject({ source: "trial", entitled: true })
  })
  it("clears expired contact and prunes records absent from the saved tenants", async () => {
    const license = service(); await connect(license); await license.tenantTrialAction(A, "trial_contact", "admin@contoso.example")
    vi.setSystemTime(ends[A]! + 15 * DAY); license.status(connected)
    expect(trialRecord().email).toBeUndefined()
    connected = []; service()
    expect(trialRecord()).toBeUndefined()
  })
  it.each(["licensed", "app_update_required", "disabled"])("expires a temporary %s refusal", async reason => {
    const license = service()
    answer = (_path, body) => body.action === "start_trial" ? refusal(reason, true) : undefined
    connected.push(A); await license.checkTrialHealth(); await expect(license.startTenantTrial(A)).rejects.toThrow()
    expect(license.status(connected).tenants[0]?.trialRefusalPermanent).toBe(false)
    vi.setSystemTime(NOW + 7 * 3600_000)
    expect(license.status(connected).tenants[0]?.trialRefusal).toBeUndefined()
  })
  it("clears a temporary refusal after an app update", async () => {
    const license = service(); connected.push(A)
    answer = (_path, body) => body.action === "start_trial" ? refusal("app_update_required", true) : undefined
    await license.checkTrialHealth(); await expect(license.startTenantTrial(A)).rejects.toThrow()
    expect(service("0.6.0").status(connected).tenants[0]?.trialRefusal).toBeUndefined()
  })
  it("requires a Community choice when both trial tokens end", async () => {
    const license = service(); await connect(license, A); await connect(license, B)
    vi.setSystemTime(ends[A]!); await license.refreshAll(); await flush()
    expect(license.status(connected)).toMatchObject({ communityTenantId: null, communityChoicePendingTenantIds: expect.arrayContaining([A, B]) })
    expect(license.status(connected).tenants.every(t => !t.entitled && t.coverageEnded && t.plan === null)).toBe(true)
  })
  it("caps health failure backoff instead of caching failure indefinitely", async () => {
    answer = path => path === "health" ? Response.json({}, { status: 503 }) : undefined
    const license = service()
    let now = NOW
    for (let attempt = 0; attempt < 7; attempt++) {
      await license.checkTrialHealth()
      expect(calls).toHaveLength(attempt + 1)
      now += Math.min(2 * 2 ** attempt, 30) * 60_000
      vi.setSystemTime(now)
    }
  })
  it("clears a transient refusal when organization coverage changes", async () => {
    const license = service(); connected.push(A)
    answer = (_path, body) => body.action === "start_trial" ? refusal("licensed", true) : undefined
    await license.checkTrialHealth(); await expect(license.startTenantTrial(A)).rejects.toThrow()
    answer = (_path, body) => body.action === "activate" ? granted(A, "tenant") : undefined
    await license.retry([A])
    expect(license.status(connected).tenants[0]?.trialRefusal).toBeUndefined()
  })
  it("ends the pending automatic window after the deadline", async () => {
    enabled = false; const license = service(); await connect(license)
    enabled = true; vi.setSystemTime(NOW + 73 * 3600_000); await license.refreshAll(); await flush()
    expect(trialRecord().stopped).toBe(true)
    expect(calls.some(c => c.body.action === "start_trial")).toBe(false)
  })
  it("takes the extended date from the server", async () => {
    const license = service(); await connect(license); vi.setSystemTime(NOW + 10 * DAY)
    await license.tenantTrialAction(A, "extend_trial")
    expect(license.status(connected).tenants[0]?.trialEndsAt).toBe(new Date(NOW + 33 * DAY).toISOString())
  })

  it("keeps a trial outside a full paid key's local limit", async () => {
    const license = service(); await connect(license); connected.push(B); limit = 1
    await license.setKey("LICENSE-KEY-FIRST", [B]); await license.refreshAll()
    expect(calls.some(c => c.path === "activate" && c.body.tenantId === A)).toBe(false)
    expect(license.status(connected).tenants.find(t => t.tenantId === A)).toMatchObject({ source: "trial", entitled: true })
  })
  it("purges a converted trial's cached contact after its end window", async () => {
    const license = service(); await connect(license); await license.tenantTrialAction(A, "trial_contact", "admin@contoso.example")
    connected.push(B); await license.setKey("LICENSE-KEY-FIRST", [B])
    vi.setSystemTime(ends[A]! + 15 * DAY); license.status(connected)
    expect(trialRecord().email).toBeUndefined()
  })

})
