import { generateKeyPairSync, sign } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LicenseService } from "../src/main/license/service"
import { memoryStore } from "./helpers"
const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const tenant = "11111111-2222-4333-8444-555555555555"
const install = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f"
const day = 86400_000
const start = Date.UTC(2026, 10, 10)
let store: ReturnType<typeof memoryStore>
let calls: Record<string, unknown>[]
let enabled: boolean
let canEnd: boolean
let end: number
let response: ((body: Record<string, unknown>) => Response) | undefined
function entitlement(source = "trial") {
  const payload = { v: 2, sub: source === "trial" ? "trial:0123456789abcdef" : "paid", act: source === "trial" ? "trial-0123456789abcdef0123456789abcdef" : "paid-1", plan: "pro", tenants: 2, tenantId: tenant, installId: install, status: "granted", iat: Date.now() / 1000, exp: end / 1000, ...(source === "trial" ? { trial: true, keyExp: end / 1000 } : {}) }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return Response.json({ token: `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`, activationId: payload.act, source, trial: source === "trial", keyExp: end / 1000, canEnd })
}
function service(existing: string[] = []) {
  return new LicenseService({ store, persist: true, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), apiBase: "https://www.tenuvault.com", appVersion: "0.5.0", initialTenantIds: existing, connectedTenantIds: () => [tenant], idToken: async () => "signed.id.token", fetch: (async (_url, init) => {
    if (!init?.body) return Response.json({ tenantTrials: { enabled } })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push(body)
    if (response) return response(body)
    if (body.action === "activate") return Response.json({ reason: "tenant_not_licensed" }, { status: 403 })
    if (body.action === "end_trial" || body.action === "trial_contact") return Response.json({ success: true })
    return entitlement()
  }) as typeof fetch })
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start); store = memoryStore(); store.set("license.installId", install); calls = []; enabled = true; canEnd = true; end = start + 14 * day; response = undefined; vi.spyOn(console, "warn").mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe("tenant trials", () => {
  it.each([true, false])("starts or joins and keeps canEnd %s", async starter => {
    canEnd = starter
    const license = service()
    await expect(license.checkNewTenant(tenant)).resolves.toBe("pro")
    expect(calls.find(c => c.action === "start_trial")).toMatchObject({ source: "auto", installId: install, os: process.platform, appVersion: "0.5.0" })
    expect(service().status([tenant]).tenants[0]).toMatchObject({ source: "trial", trial: true, canEnd: starter })
  })
  it.each(["used", "licensed", "install_limit", "disabled", "app_update_required"])("records refusal %s and never retries", async reason => {
    response = body => body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : Response.json({ error: "trial_unavailable", reason }, { status: 403 })
    const license = service()
    await license.checkNewTenant(tenant)
    const count = calls.filter(c => c.action === "start_trial").length
    await license.refreshAll()
    expect(calls.filter(c => c.action === "start_trial")).toHaveLength(count)
    expect(license.status([tenant]).tenants[0]?.trialRefusal).toBeTruthy()
    expect(license.status([]).tenantTrialsEnabled).toBe(!["disabled", "app_update_required"].includes(reason))
  })
  it("falls back on an old server", async () => {
    response = () => Response.json({ reason: "bad_request" }, { status: 400 })
    const license = service()
    await license.checkNewTenant(tenant)
    expect(license.status([]).tenantTrialsEnabled).toBe(false)
  })
  it("leaves existing tenants on Community until opt-in", async () => {
    store.set("license.communityTenant", tenant)
    const license = service([tenant])
    await license.checkNewTenant(tenant)
    expect(calls.some(c => c.action === "start_trial")).toBe(false)
    await license.startTenantTrial(tenant)
    expect(calls.find(c => c.action === "start_trial")?.source).toBe("opt-in")
    expect(license.status([tenant]).communityTenantId).toBeNull()
  })
  it("does not start with a key or while disabled", async () => {
    enabled = false
    const license = service()
    await license.checkNewTenant(tenant)
    expect(calls.some(c => c.action === "start_trial")).toBe(false)
    store.set("license.state", JSON.stringify({ key: "PAID-KEY-12345", activations: {} }))
    await service().checkNewTenant(tenant)
    expect(calls.some(c => c.action === "start_trial")).toBe(false)
  })
  it.each([71, 73])("retries a transient start only inside 72 hours (%s)", async hours => {
    response = () => Response.json({ reason: "storage_unavailable" }, { status: 503 })
    const license = service()
    await license.checkNewTenant(tenant)
    response = undefined
    vi.setSystemTime(start + hours * 3600_000)
    await service().refreshAll()
    expect(service().status([tenant]).trial).toBe(hours < 72)
  })
  it("keeps a cached trial on 503 and ends offline at keyExp", async () => {
    const license = service()
    await license.checkNewTenant(tenant)
    response = () => Response.json({ reason: "storage_unavailable" }, { status: 503 })
    await license.refreshAll()
    expect(license.status([tenant]).trial).toBe(true)
    vi.setSystemTime(end)
    expect(license.status([tenant]).tenants[0]).toMatchObject({ entitled: false, coverageEnded: true })
    expect(license.status([tenant]).trialEndedAt).toBe(new Date(end).toISOString())
  })
  it("drops an expired trial with coverage evidence", async () => {
    const license = service()
    await license.checkNewTenant(tenant)
    response = body => Response.json({ reason: body.action === "activate" ? "tenant_not_licensed" : "expired" }, { status: 403 })
    await license.refreshAll()
    expect(license.status([tenant]).tenants[0]).toMatchObject({ activated: false, coverageEnded: true, entitled: false })
  })
  it.each([10, 16])("extends during or after the trial (%s days)", async days => {
    const license = service()
    await license.checkNewTenant(tenant)
    vi.setSystemTime(start + days * day)
    if (days > 14) { response = () => Response.json({ reason: "expired" }, { status: 403 }); await license.refreshAll(); response = undefined }
    end = Math.max(end, Date.now()) + 14 * day
    await license.tenantTrialAction(tenant, "extend_trial")
    expect(license.status([tenant]).trialEndsAt).toBe(new Date(end).toISOString())
    expect(license.status([tenant]).tenants[0]?.trialCanExtend).toBe(false)
    await expect(license.tenantTrialAction(tenant, "extend_trial")).rejects.toThrow("cannot be extended")
  })
  it.each([true, false])("ends early only on the starter (%s)", async starter => {
    canEnd = starter
    const license = service()
    await license.checkNewTenant(tenant)
    if (!starter) await expect(license.tenantTrialAction(tenant, "end_trial")).rejects.toThrow("Only the installation")
    else { await license.tenantTrialAction(tenant, "end_trial"); expect(license.status([tenant]).tenants[0]?.entitled).toBe(false); expect(await license.requireEntitlement(tenant)).toBe("community") }
  })
  it("sends contact only explicitly, then replaces and deletes it", async () => {
    const license = service()
    await license.checkNewTenant(tenant)
    expect(calls.some(c => c.email)).toBe(false)
    await license.tenantTrialAction(tenant, "trial_contact", "admin@contoso.example")
    expect(license.status([tenant]).tenants[0]?.trialEmail).toBe("admin@contoso.example")
    await license.tenantTrialAction(tenant, "trial_contact")
    expect(calls.at(-1)).not.toHaveProperty("email")
  })
  it.each(["key", "tenant"])("replaces the trial with %s", async source => {
    const license = service()
    await license.checkNewTenant(tenant)
    response = () => entitlement(source)
    if (source === "key") await license.setKey("PAID-KEY-12345", [tenant])
    else await license.refreshAll()
    expect(license.status([tenant]).tenants[0]).toMatchObject({ source, trial: false })
    response = () => Response.json({ reason: "expired" }, { status: 403 })
    await license.refreshAll()
    expect(license.status([tenant]).tenants[0]?.trialEndsAt).toBeNull()
    expect(license.status([tenant]).trialEndedAt).toBeNull()
  })
  it("keeps contact and end failures from dropping cached coverage", async () => {
    const license = service()
    await license.checkNewTenant(tenant)
    response = () => Response.json({ reason: "storage_unavailable" }, { status: 503 })
    for (const action of ["trial_contact", "end_trial"] as const) {
      await expect(license.tenantTrialAction(tenant, action)).rejects.toThrow()
      expect(license.status([tenant]).trial).toBe(true)
    }
  })
  it.each(["used", "not_starter"])("shows mutation refusal %s and stops refused extensions", async reason => {
    const license = service()
    await license.checkNewTenant(tenant)
    vi.setSystemTime(start + 10 * day)
    response = () => Response.json({ error: "trial_unavailable", reason }, { status: 403 })
    await expect(license.tenantTrialAction(tenant, "extend_trial")).rejects.toThrow()
    expect(license.status([tenant]).tenants[0]?.trialCanExtend).toBe(false)
    expect(license.status([tenant]).trial).toBe(true)
  })
  it("does not accept a malformed trial answer", async () => {
    const license = service()
    response = body => body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : Response.json({ token: "invalid", activationId: "bad" })
    await license.checkNewTenant(tenant)
    expect(license.status([tenant]).tenantTrialsEnabled).toBe(false)
    expect(license.status([tenant]).trial).toBe(false)
  })
  it("retains the fallback after health fails", async () => {
    const license = new LicenseService({ store, persist: true, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), apiBase: "https://www.tenuvault.com", appVersion: "0.5.0", fetch: (async () => { throw new Error("offline") }) as typeof fetch })
    await license.checkNewTenant(tenant)
    expect(license.status([tenant]).tenantTrialsEnabled).toBe(false)
    expect(license.status([tenant]).tenants[0]?.plan).toBe("community")
  })

})
