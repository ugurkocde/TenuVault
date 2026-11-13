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
let healthFields: Record<string, unknown>
let requests: number
let enabled: boolean
let canEnd: boolean
let end: number
let response: ((body: Record<string, unknown>) => Response) | undefined
function entitlement(source = "trial", tenantId = tenant) {
  const payload = { v: 2, sub: source === "trial" ? "trial:0123456789abcdef" : "paid", act: source === "trial" ? "trial-0123456789abcdef0123456789abcdef" : "paid-1", plan: "pro", tenants: 2, tenantId, installId: install, status: "granted", iat: Date.now() / 1000, exp: end / 1000, ...(source === "trial" ? { trial: true, keyExp: end / 1000 } : {}) }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return Response.json({ token: `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`, activationId: payload.act, source, trial: source === "trial", keyExp: end / 1000, canEnd })
}
function service(existing: string[] = []) {
  return new LicenseService({ store, persist: true, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), apiBase: "https://www.tenuvault.com", appVersion: "0.5.0", initialTenantIds: store.get("license.tenantTrials") ? [...new Set([tenant, ...existing])] : existing, connectedTenantIds: () => [tenant], idToken: async () => "signed.id.token", fetch: (async (_url, init) => {
    requests++
    if (!init?.body) return Response.json({ tenantTrials: { enabled, ok: true, ...healthFields } })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push(body)
    if (response) return response(body)
    if (body.action === "activate") return Response.json({ reason: "tenant_not_licensed" }, { status: 403 })
    if (body.action === "end_trial" || body.action === "trial_contact") return Response.json({ success: true })
    return entitlement()
  }) as typeof fetch })
}
async function connect(license: LicenseService) {
  await license.checkTrialHealth()
  return license.checkNewTenant(tenant)
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start); store = memoryStore(); store.set("license.installId", install); calls = []; requests = 0; healthFields = {}; enabled = true; canEnd = true; end = start + 14 * day; response = undefined; vi.spyOn(console, "warn").mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe("tenant trials", () => {
  it.each([true, false])("starts or joins and keeps canEnd %s", async starter => {
    canEnd = starter
    const license = service()
    await expect(connect(license)).resolves.toBe("pro")
    expect(calls.find(c => c.action === "start_trial")).toMatchObject({ source: "auto", installId: install, os: process.platform, appVersion: "0.5.0" })
    expect(service().status([tenant]).tenants[0]).toMatchObject({ source: "trial", trial: true, canEnd: starter })
  })
  it.each(["used", "licensed", "install_limit", "disabled", "app_update_required"])("records refusal %s and never retries", async reason => {
    response = body => body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : Response.json({ error: "trial_unavailable", reason }, { status: 403 })
    const license = service()
    await connect(license)
    const count = calls.filter(c => c.action === "start_trial").length
    await license.refreshAll()
    expect(calls.filter(c => c.action === "start_trial")).toHaveLength(count)
    expect(license.status([tenant]).tenants[0]?.trialRefusal).toBeTruthy()
    expect(license.status([]).tenantTrialsEnabled).toBe(!["disabled", "app_update_required"].includes(reason))
    // The dashboard trial card reads this to stop offering trials on this installation.
    expect(service().status([]).tenantTrialInstallLimit).toBe(reason === "install_limit")
  })
  it("keeps the installation's trial limit after tenant removal, deactivation and a restart", async () => {
    response = body => body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : Response.json({ error: "trial_unavailable", reason: "install_limit" }, { status: 403 })
    const license = service()
    await connect(license)
    expect(license.status([tenant]).tenantTrialInstallLimit).toBe(true)
    await license.releaseTenant(tenant)
    // The tenant's own trial record is gone; the installation marker is not.
    expect(store.get("license.tenantTrials")).toBeNull()
    expect(license.status([]).tenantTrialInstallLimit).toBe(true)
    expect(service().status([]).tenantTrialInstallLimit).toBe(true)
    await license.deactivate()
    expect(license.status([]).tenantTrialInstallLimit).toBe(true)
    expect(service().status([]).tenantTrialInstallLimit).toBe(true)
    // The trial service counts per installation ID, so a new ID starts without the limit.
    store.set("license.installId", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")
    expect(service().status([]).tenantTrialInstallLimit).toBe(false)
  })
  describe("an install_limit refusal saved by an older version", () => {
    const legacy = () => store.set("license.tenantTrials", JSON.stringify({ [tenant]: { stopped: true, refusal: "This installation has already started its available tenant trials.", refusalReason: "install_limit", refusalAt: start, refusalVersion: "0.4.0" } }))
    it("becomes the installation's limit and survives removal, deactivation and restarts", async () => {
      legacy()
      const license = service()
      expect(license.status([tenant]).tenantTrialInstallLimit).toBe(true)
      expect(store.get("license.tenantTrialInstallLimit")).toBe(install)
      await license.releaseTenant(tenant)
      expect(store.get("license.tenantTrials")).toBeNull()
      expect(license.status([]).tenantTrialInstallLimit).toBe(true)
      expect(service().status([]).tenantTrialInstallLimit).toBe(true)
      await license.deactivate()
      expect(service().status([]).tenantTrialInstallLimit).toBe(true)
    })
    it("does not carry over to a new installation ID while the old record stays", () => {
      legacy()
      expect(service().status([tenant]).tenantTrialInstallLimit).toBe(true)
      store.set("license.installId", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")
      const restarted = service()
      expect(restarted.status([tenant]).tenants[0]?.trialRefusal).toBeTruthy()
      expect(restarted.status([tenant]).tenantTrialInstallLimit).toBe(false)
    })
  })
  it("falls back on an old server", async () => {
    response = body => body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : Response.json({ reason: "bad_request" }, { status: 400 })
    const license = service()
    await connect(license)
    expect(license.status([]).tenantTrialsEnabled).toBe(false)
  })
  it.each(["seen", "claim"])("leaves an existing tenant on Community with only the %s guard", async guard => {
    if (guard === "claim") store.set("license.communityTenant", tenant)
    const license = service(guard === "seen" ? [tenant] : [])
    await connect(license)
    expect(calls.some(c => c.action === "start_trial")).toBe(false)
    await license.startTenantTrial(tenant)
    expect(calls.find(c => c.action === "start_trial")?.source).toBe("opt-in")
    expect(license.status([tenant]).communityTenantId).toBeNull()
  })
  it("does not start with a key or while disabled", async () => {
    enabled = false
    const license = service()
    await connect(license)
    expect(calls.some(c => c.action === "start_trial")).toBe(false)
    store.set("license.state", JSON.stringify({ key: "PAID-KEY-12345", activations: {} }))
    await service().checkNewTenant(tenant)
    expect(calls.some(c => c.action === "start_trial")).toBe(false)
  })
  it.each([71, 73])("retries a transient start only inside 72 hours (%s)", async hours => {
    response = body => body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : Response.json({ reason: "storage_unavailable" }, { status: 503 })
    const license = service()
    await connect(license)
    response = undefined
    vi.setSystemTime(start + hours * 3600_000)
    await service().refreshAll()
    await new Promise(resolve => setImmediate(resolve))
    expect(service().status([tenant]).trial).toBe(hours < 72)
  })
  it("keeps a cached trial on 503 and ends offline at keyExp", async () => {
    const license = service()
    await connect(license)
    response = () => Response.json({ reason: "storage_unavailable" }, { status: 503 })
    await license.refreshAll()
    expect(license.status([tenant]).trial).toBe(true)
    vi.setSystemTime(end)
    expect(license.status([tenant]).tenants[0]).toMatchObject({ entitled: false, coverageEnded: true })
    expect(license.status([tenant]).trialEndedAt).toBe(new Date(end).toISOString())
  })
  it("drops an expired trial with coverage evidence", async () => {
    const license = service()
    await connect(license)
    response = body => Response.json({ reason: body.action === "activate" ? "tenant_not_licensed" : "expired" }, { status: 403 })
    await license.refreshAll()
    expect(license.status([tenant]).tenants[0]).toMatchObject({ activated: false, coverageEnded: true, entitled: false })
  })
  it.each([10, 16])("extends during or after the trial (%s days)", async days => {
    const license = service()
    await connect(license)
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
    await connect(license)
    if (!starter) await expect(license.tenantTrialAction(tenant, "end_trial")).rejects.toThrow("Only the installation")
    else { await license.tenantTrialAction(tenant, "end_trial"); expect(license.status([tenant]).tenants[0]?.entitled).toBe(false); expect(await license.requireEntitlement(tenant)).toBe("community") }
  })
  describe("resuming a trial that was ended early", () => {
    const trialId = "trial-0123456789abcdef0123456789abcdef"
    const tenantStatus = (license: LicenseService) => license.status([tenant]).tenants[0]!
    // A new start of the app, once it has asked the service whether trials are on.
    async function restarted() {
      const license = service()
      await license.checkTrialHealth()
      return license
    }
    async function ended() {
      const license = service()
      await connect(license)
      await license.tenantTrialAction(tenant, "end_trial")
      return license
    }
    it("offers it until the trial's original end and brings Pro back with the same end", async () => {
      const license = await ended()
      expect(tenantStatus(license)).toMatchObject({ entitled: false, trialCanResume: true, trialResumeUntil: new Date(end).toISOString(), trialRefusalPermanent: true })
      expect(license.status([tenant]).communityTenantId).toBe(tenant)
      // The offer survives a restart.
      expect(tenantStatus(await restarted())).toMatchObject({ trialCanResume: true, trialResumeUntil: new Date(end).toISOString() })
      vi.setSystemTime(start + 3 * day)
      await license.tenantTrialAction(tenant, "resume_trial")
      expect(calls.at(-1)).toMatchObject({ action: "resume_trial", activationId: trialId, installId: install, appVersion: "0.5.0" })
      const status = tenantStatus(license)
      // The same end as before: no time is gained. The welcome is not shown a second time.
      expect(status).toMatchObject({ entitled: true, source: "trial", trial: true, plan: "pro", canEnd: true, trialEndsAt: new Date(end).toISOString(), trialCanResume: false, trialAcknowledged: true, trialRefusalPermanent: false })
      expect(status.trialRefusal).toBeUndefined()
      expect(status.trialResumeUntil).toBeUndefined()
      expect(license.status([tenant]).communityTenantId).toBeNull()
      expect(await license.requireEntitlement(tenant)).toBe("pro")
      expect(tenantStatus(await restarted())).toMatchObject({ entitled: true, trial: true, trialCanResume: false })
      // It then runs like any trial: it can be extended in its window, and its end is announced.
      vi.setSystemTime(end - 4 * day)
      expect(tenantStatus(license).trialCanExtend).toBe(true)
      vi.setSystemTime(end)
      expect(tenantStatus(license)).toMatchObject({ entitled: false, trialCanResume: false })
      expect(tenantStatus(license).trialAcknowledged).toBeFalsy()
    })
    it("clears a refusal recorded while the trial was ended", async () => {
      const license = await ended()
      response = body => body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : Response.json({ error: "trial_unavailable", reason: "used" }, { status: 403 })
      await expect(license.startTenantTrial(tenant)).rejects.toThrow("already had a Pro trial")
      response = undefined
      expect(tenantStatus(license)).toMatchObject({ trialCanResume: true, trialRefusalPermanent: true })
      await license.tenantTrialAction(tenant, "resume_trial")
      expect(tenantStatus(license)).toMatchObject({ entitled: true, trial: true, trialRefusalPermanent: false })
      expect(tenantStatus(license).trialRefusal).toBeUndefined()
      expect(tenantStatus(await restarted()).trialRefusal).toBeUndefined()
    })
    it("stops offering it at the original end without asking the service", async () => {
      const license = await ended()
      vi.setSystemTime(end)
      expect(tenantStatus(license)).toMatchObject({ trialCanResume: false, trialRefusalPermanent: true })
      const before = calls.length
      await expect(license.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow("can no longer be resumed")
      expect(calls).toHaveLength(before)
    })
    it("is offered next to a license for another tenant, where the trial switch is never asked", async () => {
      await ended()
      const other = "99999999-2222-4333-8444-555555555555"
      const saved = JSON.parse(store.get("license.state")!)
      store.set("license.state", JSON.stringify({ ...saved, activations: { ...saved.activations, [other]: { activationId: "org-1", token: "invalid.token", source: "tenant" } } }))
      const before = requests
      const license = await restarted()
      // With a license on the installation the app does not ask whether trials are on.
      expect(requests).toBe(before)
      expect(license.status([tenant]).tenantTrialsEnabled).toBe(false)
      expect(tenantStatus(license)).toMatchObject({ trialCanResume: true, trialResumeUntil: new Date(end).toISOString() })
      await license.tenantTrialAction(tenant, "resume_trial")
      expect(tenantStatus(license)).toMatchObject({ entitled: true, source: "trial", trial: true, trialCanResume: false })
    })
    it("uses the end the service gave when the trial was ended, after an extension by another installation", async () => {
      const license = service()
      await connect(license)
      const extendedEnd = end + 14 * day
      response = body => body.action === "end_trial" ? Response.json({ success: true, endsAt: new Date(extendedEnd).toISOString() }) : body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : entitlement()
      await license.tenantTrialAction(tenant, "end_trial")
      response = undefined
      expect(tenantStatus(license)).toMatchObject({ trialCanResume: true, trialResumeUntil: new Date(extendedEnd).toISOString() })
      // Past the end this installation knew, inside the extended one, also after a restart.
      vi.setSystemTime(end + day)
      expect(tenantStatus(await restarted())).toMatchObject({ trialCanResume: true, trialResumeUntil: new Date(extendedEnd).toISOString() })
      end = extendedEnd
      await license.tenantTrialAction(tenant, "resume_trial")
      expect(tenantStatus(license)).toMatchObject({ entitled: true, trial: true, trialEndsAt: new Date(extendedEnd).toISOString() })
      vi.setSystemTime(extendedEnd)
      expect(tenantStatus(license)).toMatchObject({ entitled: false, trialCanResume: false })
    })
    it.each(["not a date", 12345, null])("ignores an unusable end in the answer to an ending (%s)", async endsAt => {
      const license = service()
      await connect(license)
      response = body => body.action === "end_trial" ? Response.json({ success: true, endsAt }) : entitlement()
      await license.tenantTrialAction(tenant, "end_trial")
      response = undefined
      expect(tenantStatus(license)).toMatchObject({ trialCanResume: true, trialResumeUntil: new Date(end).toISOString() })
    })
    it("asks for an update in its own words when the app is too old to resume", async () => {
      const license = await ended()
      response = () => Response.json({ error: "trial_unavailable", reason: "app_update_required" }, { status: 403 })
      await expect(license.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow("Update TenuVault to resume this trial.")
      response = undefined
      expect(tenantStatus(license).trialCanResume).toBe(true)
    })
    it("is not offered for a running trial or with a saved key, and is left to the service while trials are off", async () => {
      const license = service()
      await connect(license)
      expect(tenantStatus(license).trialCanResume).toBe(false)
      await expect(license.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow("can no longer be resumed")
      await license.tenantTrialAction(tenant, "end_trial")
      const saved = JSON.parse(store.get("license.state")!)
      store.set("license.state", JSON.stringify({ ...saved, key: "PAID-KEY-12345" }))
      expect(tenantStatus(await restarted()).trialCanResume).toBe(false)
      store.set("license.state", JSON.stringify(saved))
      expect(tenantStatus(await restarted()).trialCanResume).toBe(true)
      // The switch is the service's to enforce: the offer stays and the refusal is shown.
      enabled = false
      const off = service()
      vi.setSystemTime(start + day)
      await off.checkTrialHealth()
      expect(off.status([tenant]).tenantTrialsEnabled).toBe(false)
      expect(tenantStatus(off).trialCanResume).toBe(true)
      response = () => Response.json({ error: "trial_unavailable", reason: "disabled" }, { status: 403 })
      await expect(off.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow("currently unavailable")
      expect(tenantStatus(off)).toMatchObject({ entitled: false, trialCanResume: true })
    })
    it.each(["used", "not_starter"])("stops offering it for good when the service answers %s", async reason => {
      const license = await ended()
      response = () => Response.json({ error: "trial_unavailable", reason }, { status: 403 })
      await expect(license.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow("This trial can no longer be resumed.")
      response = undefined
      expect(tenantStatus(license)).toMatchObject({ entitled: false, trialCanResume: false })
      expect(tenantStatus(await restarted()).trialCanResume).toBe(false)
      const before = calls.length
      await expect(license.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow("can no longer be resumed")
      expect(calls).toHaveLength(before)
    })
    it.each([
      ["licensed", 403, { error: "trial_unavailable", reason: "licensed" }, "already has an organization license"],
      ["disabled", 403, { error: "trial_unavailable", reason: "disabled" }, "currently unavailable"],
      ["an outage", 503, { reason: "storage_unavailable" }, "unavailable"],
    ] as const)("keeps the offer when the service answers %s", async (_name, status, body, message) => {
      const license = await ended()
      response = () => Response.json(body, { status })
      await expect(license.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow(message)
      response = undefined
      expect(tenantStatus(license)).toMatchObject({ entitled: false, trialCanResume: true })
      expect(await license.requireEntitlement(tenant)).toBe("community")
      await license.tenantTrialAction(tenant, "resume_trial")
      expect(tenantStatus(license)).toMatchObject({ entitled: true, trial: true })
    })
    it("keeps trials on when an older service does not know resuming", async () => {
      const license = await ended()
      response = () => Response.json({ error: "Invalid request.", reason: "bad_request" }, { status: 400 })
      await expect(license.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow("updated licensing service")
      response = undefined
      expect(license.status([tenant]).tenantTrialsEnabled).toBe(true)
      expect(tenantStatus(license)).toMatchObject({ entitled: false, trialCanResume: true })
    })
    it("accepts only a valid trial entitlement", async () => {
      const license = await ended()
      response = () => Response.json({ success: true })
      await expect(license.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow()
      response = () => entitlement("paid")
      await expect(license.tenantTrialAction(tenant, "resume_trial")).rejects.toThrow()
      response = undefined
      expect(tenantStatus(license)).toMatchObject({ entitled: false, trialCanResume: true })
      expect(await license.requireEntitlement(tenant)).toBe("community")
    })
  })
  it("sends contact only explicitly, then replaces and deletes it", async () => {
    const license = service()
    await connect(license)
    expect(calls.some(c => c.email)).toBe(false)
    await license.tenantTrialAction(tenant, "trial_contact", "admin@contoso.example")
    expect(license.status([tenant]).tenants[0]?.trialEmail).toBe("admin@contoso.example")
    await license.tenantTrialAction(tenant, "trial_contact")
    expect(calls.at(-1)).not.toHaveProperty("email")
  })
  it.each(["key", "tenant"])("replaces the trial with %s", async source => {
    const license = service()
    await connect(license)
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
    await connect(license)
    response = () => Response.json({ reason: "storage_unavailable" }, { status: 503 })
    for (const action of ["trial_contact", "end_trial"] as const) {
      await expect(license.tenantTrialAction(tenant, action)).rejects.toThrow()
      expect(license.status([tenant]).trial).toBe(true)
    }
  })
  it.each(["used", "not_starter"])("shows mutation refusal %s and only retires used extensions", async reason => {
    const license = service()
    await connect(license)
    vi.setSystemTime(start + 10 * day)
    response = () => Response.json({ error: "trial_unavailable", reason }, { status: 403 })
    await expect(license.tenantTrialAction(tenant, "extend_trial")).rejects.toThrow()
    expect(license.status([tenant]).tenants[0]?.trialCanExtend).toBe(reason !== "used")
    expect(license.status([tenant]).trial).toBe(true)
  })
  it("does not accept a malformed trial answer", async () => {
    const license = service()
    response = body => body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : Response.json({ token: "invalid", activationId: "bad" })
    await connect(license)
    expect(license.status([tenant]).tenantTrialsEnabled).toBe(false)
    expect(license.status([tenant]).trial).toBe(false)
  })
  it("retains the fallback after health fails", async () => {
    const license = new LicenseService({ store, persist: true, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), apiBase: "https://www.tenuvault.com", appVersion: "0.5.0", fetch: (async () => { throw new Error("offline") }) as typeof fetch })
    await connect(license)
    expect(license.status([tenant]).tenantTrialsEnabled).toBe(false)
    expect(license.status([tenant]).tenants[0]?.plan).toBe("community")
  })

  it("checks organization coverage before any automatic start", async () => {
    response = () => entitlement("tenant")
    const license = service()
    await connect(license)
    await license.refreshAll()
    expect(license.status([tenant]).tenants[0]?.source).toBe("tenant")
    expect(calls.some(body => body.action === "start_trial")).toBe(false)
  })
  it("retries a network failure starting a trial", async () => {
    response = body => {
      if (body.action === "activate") return Response.json({ reason: "tenant_not_licensed" }, { status: 403 })
      throw new TypeError("fetch failed")
    }
    const license = service()
    await connect(license)
    expect(license.status([tenant]).tenants[0]?.plan).toBe("community")
    vi.setSystemTime(start + 3600_000)
    response = undefined
    await license.refreshAll()
    expect(license.status([tenant]).trial).toBe(true)
  })
  it("says why no automatic trial started, for setup diagnostics", async () => {
    response = body => {
      if (body.action === "activate") return Response.json({ reason: "tenant_not_licensed" }, { status: 403 })
      throw new TypeError("fetch failed")
    }
    const failed = service()
    await connect(failed)
    expect(failed.trialSkipReason(tenant.toUpperCase())).toBe("trial_request_failed")

    store = memoryStore()
    store.set("license.installId", install)
    response = body => body.action === "activate" ? Response.json({ reason: "tenant_not_licensed" }, { status: 403 }) : Response.json({ error: "trial_unavailable", reason: "used" }, { status: 403 })
    const refused = service()
    await connect(refused)
    expect(refused.trialSkipReason(tenant)).toBe("used")

    store = memoryStore()
    store.set("license.installId", install)
    response = () => Response.json({ reason: "revoked" }, { status: 403 })
    const denied = service()
    await connect(denied)
    expect(denied.trialSkipReason(tenant)).toBe("revoked")

    store = memoryStore()
    store.set("license.installId", install)
    response = undefined
    enabled = false
    const unavailable = service()
    await connect(unavailable).catch(() => undefined)
    expect(unavailable.trialSkipReason(tenant)).toBe("trials_unavailable")
  })
  it("names a failed activation as the reason", async () => {
    response = () => { throw new TypeError("fetch failed") }
    const offline = service()
    await connect(offline).catch(() => undefined)
    expect(offline.trialSkipReason(tenant)).toBe("activation_failed")
  })

})

describe("trial policy and tray reminders", () => {
  it.each([
    [{}, {}],
    [{ days: 10, extensionDays: 12, extensionWindowDays: 3, extensionGraceDays: 7 }, { days: 10, extensionDays: 12, extensionWindowDays: 3, extensionGraceDays: 7 }],
    [{ days: 0, extensionDays: 1.5, extensionWindowDays: "5", extensionGraceDays: 366 }, {}],
    [{ days: -1, extensionDays: null, extensionWindowDays: true, extensionGraceDays: [] }, {}],
  ])("validates optional health lengths %j", async (fields, expected) => {
    healthFields = fields
    const license = service()
    await license.checkTrialHealth()
    expect(license.status([]).tenantTrialPolicy).toEqual(expected)
    await license.checkTrialHealth()
    expect(license.status([]).tenantTrialPolicy).toEqual(expected)
  })
  it("uses the reported extension window and grace", async () => {
    healthFields = { extensionWindowDays: 3, extensionGraceDays: 7 }
    const license = service()
    await connect(license)
    vi.setSystemTime(end - 4 * day)
    expect(license.status([tenant]).tenants[0]!.trialCanExtend).toBe(false)
    expect(license.status([tenant]).tenants[0]!.trialExtensionAvailableAt).toBe(new Date(end - 3 * day).toISOString())
    vi.setSystemTime(end - 3 * day)
    expect(license.status([tenant]).tenants[0]!.trialCanExtend).toBe(true)
    vi.setSystemTime(end + 8 * day)
    expect(license.status([tenant]).tenants[0]!.trialCanExtend).toBe(false)
  })
  it("sends each reminder once per end and persists across restart", async () => {
    const license = service()
    await connect(license)
    const notify = vi.fn(() => true)
    license.notifyTrials(notify)
    expect(notify).not.toHaveBeenCalled()
    vi.setSystemTime(end - day)
    license.notifyTrials(notify)
    license.notifyTrials(notify)
    expect(notify).toHaveBeenCalledExactlyOnceWith(tenant, false, end, expect.any(Boolean))
    const restarted = service()
    await restarted.checkTrialHealth()
    restarted.notifyTrials(notify)
    expect(notify).toHaveBeenCalledTimes(1)
    vi.setSystemTime(end)
    restarted.notifyTrials(notify)
    restarted.notifyTrials(notify)
    expect(notify).toHaveBeenLastCalledWith(tenant, true, end, expect.any(Boolean))
    const again = service()
    await again.checkTrialHealth()
    again.notifyTrials(notify)
    expect(notify).toHaveBeenCalledTimes(2)
  })
  it("re-arms at the extended end and retries unsupported notifications", async () => {
    const license = service()
    await connect(license)
    vi.setSystemTime(end - day)
    license.notifyTrials(() => false)
    const notify = vi.fn(() => true)
    license.notifyTrials(notify)
    end += 10 * day
    await license.tenantTrialAction(tenant, "extend_trial")
    license.notifyTrials(notify)
    expect(notify).toHaveBeenCalledTimes(1)
    vi.setSystemTime(end - day)
    license.notifyTrials(notify)
    expect(notify).toHaveBeenCalledTimes(2)
  })
  it.each(["disabled", "key", "organization", "ended-early"])("does not notify for %s", async kind => {
    const license = service()
    await connect(license)
    if (kind === "ended-early") await license.tenantTrialAction(tenant, "end_trial")
    if (kind === "disabled") { enabled = false; vi.setSystemTime(start + day); await license.checkTrialHealth() }
    if (kind === "key" || kind === "organization") {
      const saved = JSON.parse(store.get("license.state")!)
      if (kind === "key") saved.key = "PAID-KEY"
      else saved.activations[tenant].source = "tenant"
      store.set("license.state", JSON.stringify(saved))
    }
    vi.setSystemTime(end - day)
    const subject = kind === "key" || kind === "organization" ? service() : license
    if (subject !== license) await subject.checkTrialHealth()
    const notify = vi.fn(() => true)
    subject.notifyTrials(notify)
    expect(notify).not.toHaveBeenCalled()
  })
})

it("bounds local usage by verified trial dates without changing the trial record", async () => {
  const license = service()
  expect(license.trialUsagePeriod(tenant)).toBeNull()
  await connect(license)
  const stored = store.get("license.tenantTrials")
  expect(license.trialUsagePeriod(tenant)).toEqual({ since: start, until: end })
  expect(store.get("license.tenantTrials")).toBe(stored)
  healthFields = { days: 10 }
  const restarted = service()
  await restarted.checkTrialHealth()
  expect(restarted.trialUsagePeriod(tenant)).toEqual({ since: end - 10 * day, until: end })
  vi.setSystemTime(end - day)
  end += 10 * day
  await restarted.tenantTrialAction(tenant, "extend_trial")
  expect(restarted.trialUsagePeriod(tenant)).toEqual({ since: start, until: end })
  enabled = false
  vi.setSystemTime(end - day)
  await restarted.checkTrialHealth()
  expect(restarted.trialUsagePeriod(tenant)).toBeNull()
})


it.each([
  [undefined, 60, true], [undefined, 61, false], [7, 21, true], [7, 61, false],
] as const)("limits end notifications independently to the recent-expiry window (%s, %s)", async (grace, age, expected) => {
  healthFields = grace === undefined ? {} : { extensionGraceDays: grace }
  const license = service()
  await connect(license)
  vi.setSystemTime(end + age * day)
  const notify = vi.fn(() => true)
  license.notifyTrials(notify)
  expect(notify).toHaveBeenCalledTimes(expected ? 1 : 0)
  if (expected) expect(notify).toHaveBeenCalledWith(tenant, true, end, expect.any(Boolean))
})

it.each([false, true])("keeps the first-seen usage boundary through refresh and extension (grace %s)", async grace => {
  healthFields = { days: 14, extensionDays: 10 }
  const license = service()
  await connect(license)
  const original = license.trialUsagePeriod(tenant)
  vi.setSystemTime(start + day)
  await license.refreshAll()
  expect(license.trialUsagePeriod(tenant)).toEqual(original)
  vi.setSystemTime(end + (grace ? day : -day))
  end = Math.max(end, Date.now()) + 10 * day
  await license.tenantTrialAction(tenant, "extend_trial")
  expect(license.trialUsagePeriod(tenant)?.since).toBe(grace ? start + day : start)
  expect(JSON.parse(store.get("license.tenantTrials")!)[tenant].trialFirstSeenAt).toBe(start)
})
it.each([false, true])("starts the local usage window at join, with policy %s", async policy => {
  if (policy) healthFields = { days: 14, extensionDays: 10 }
  canEnd = false
  vi.setSystemTime(start + 5 * day)
  const license = service()
  await connect(license)
  expect(license.trialUsagePeriod(tenant)?.since).toBe(start + 5 * day)
  vi.setSystemTime(start + 6 * day)
  await license.refreshAll()
  const restarted = service()
  await restarted.checkTrialHealth()
  expect(restarted.trialUsagePeriod(tenant)?.since).toBe(start + 5 * day)
  expect(license.trialUsagePeriod(tenant)?.since).toBe(start + 5 * day)
})
it("keeps a temporarily refused extension available", async () => {
  const license = service()
  await connect(license)
  vi.setSystemTime(end - day)
  for (const reason of ["disabled", "app_update_required"]) {
    response = () => Response.json({ error: "trial_unavailable", reason }, { status: 403 })
    await expect(license.tenantTrialAction(tenant, "extend_trial")).rejects.toThrow()
    expect(license.status([tenant]).tenants[0]?.trialCanExtend).toBe(true)
  }
  response = undefined
  end += 10 * day
  await license.tenantTrialAction(tenant, "extend_trial")
  expect(license.status([tenant]).tenants[0]?.trialCanExtend).toBe(false)
})
it("does not notify a removed tenant", async () => {
  const license = service()
  await connect(license)
  await license.releaseTenant(tenant)
  vi.setSystemTime(end - day)
  const notify = vi.fn(() => true)
  license.notifyTrials(notify)
  expect(notify).not.toHaveBeenCalled()
})
it("notifies two tenants in one pass", async () => {
  const license = service()
  await connect(license)
  const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  const saved = JSON.parse(store.get("license.tenantTrials")!)
  saved[other] = { ...saved[tenant], token: (await entitlement("trial", other).json()).token }
  store.set("license.tenantTrials", JSON.stringify(saved))
  const restarted = service()
  await restarted.checkTrialHealth()
  vi.setSystemTime(end - day)
  const notify = vi.fn(() => true)
  restarted.notifyTrials(notify)
  expect(notify).toHaveBeenCalledTimes(2)
  expect(notify).toHaveBeenCalledWith(other, false, end, expect.any(Boolean))
})
it("tallies Pro actions only during an enabled tenant trial, then deletes them", async () => {
  const license = service()
  license.recordTrialUsage(tenant, "dailySchedule")
  expect(store.get("license.tenantTrials")).toBeNull()
  await connect(license)
  const beforeRequests = requests
  const network = vi.fn(() => { throw new Error("Network forbidden") })
  vi.stubGlobal("fetch", network)
  for (const feature of ["dailySchedule", "azureStorage", "fullRestore", "replaceRestore", "restoreAssignments", "driftRevert"] as const) license.recordTrialUsage(tenant, feature)
  license.recordTrialUsage(tenant, "bulkActions")
  license.recordTrialUsage(tenant, "notifications")
  expect(license.trialUsageTally(tenant)).toEqual({ dailyBackups: 1, azureBackups: 1, fullRestores: 3, driftReverts: 1 })
  expect(service().status([tenant]).tenants[0]?.trial).toBe(true)
  expect(network).not.toHaveBeenCalled()
  expect(requests).toBe(beforeRequests)
  vi.unstubAllGlobals()
  await license.releaseTenant(tenant)
  expect(JSON.parse(store.get("license.tenantTrials") ?? "{}")[tenant]).toBeUndefined()
})
it.each(["off", "expired", "key", "organization", "other"])("does not tally for %s", async state => {
  const license = service()
  await connect(license)
  if (state === "off") { enabled = false; vi.setSystemTime(start + day); await license.checkTrialHealth() }
  if (state === "expired") vi.setSystemTime(end)
  if (state === "other") { license.recordTrialUsage("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "fullRestore"); expect(JSON.parse(store.get("license.tenantTrials")!)).not.toHaveProperty("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"); return }
  if (state === "key" || state === "organization") {
    const saved = JSON.parse(store.get("license.state")!)
    if (state === "key") saved.key = "PAID-KEY"
    else saved.activations[tenant].source = "tenant"
    store.set("license.state", JSON.stringify(saved))
  }
  const subject = ["key", "organization"].includes(state) ? service() : license
  subject.recordTrialUsage(tenant, "fullRestore")
  expect(JSON.parse(store.get("license.tenantTrials")!)[tenant].tally).toBeUndefined()
})
it("deactivation deletes the tally", async () => {
  const license = service()
  await connect(license)
  license.recordTrialUsage(tenant, "fullRestore")
  await license.deactivate()
  expect(store.get("license.tenantTrials")).toBeNull()
})

it.each(["key", "tenant"])("hides extension availability for %s coverage", async coverage => {
  const license = service()
  await connect(license)
  const saved = JSON.parse(store.get("license.state")!)
  if (coverage === "key") saved.key = "PAID-KEY"
  else saved.activations[tenant].source = "tenant"
  store.set("license.state", JSON.stringify(saved))
  const covered = service()
  expect(covered.status([tenant]).tenants[0]?.trialExtensionAvailableAt).toBeUndefined()
  expect(covered.status([tenant]).tenants[0]?.trialCanExtend).toBe(false)
})
it("keeps tallies separate for two live tenant trials", async () => {
  const license = service()
  await connect(license)
  const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  const data = await entitlement("trial", other).json()
  const saved = JSON.parse(store.get("license.state")!)
  saved.activations[other] = { ...saved.activations[tenant], token: data.token }
  store.set("license.state", JSON.stringify(saved))
  const trials = JSON.parse(store.get("license.tenantTrials")!)
  trials[other] = { ...trials[tenant], token: data.token }
  store.set("license.tenantTrials", JSON.stringify(trials))
  const both = service()
  await both.checkTrialHealth()
  both.recordTrialUsage(tenant, "dailySchedule")
  both.recordTrialUsage(other, "driftRevert")
  expect(both.trialUsageTally(tenant)).toEqual({ dailyBackups: 1 })
  expect(both.trialUsageTally(other)).toEqual({ driftReverts: 1 })
})

it("uses the local first-seen time without policy fields after extension", async () => {
  const license = service()
  await connect(license)
  vi.setSystemTime(start + day)
  await license.refreshAll()
  vi.setSystemTime(end - day)
  end += 10 * day
  await license.tenantTrialAction(tenant, "extend_trial")
  expect(license.trialUsagePeriod(tenant)).toEqual({ since: start, until: end })
})

it("contains a throwing store while loading for a tally", () => {
  const license = service()
  vi.spyOn(store, "get").mockImplementation(() => { throw new Error("Store unavailable") })
  expect(() => license.recordTrialUsage(tenant, "fullRestore")).not.toThrow()
})
it("contains validation errors before a tally", async () => {
  const license = service()
  await connect(license)
  vi.spyOn(license as unknown as { valid: () => never }, "valid").mockImplementation(() => { throw new Error("Validation unavailable") })
  expect(() => license.recordTrialUsage(tenant, "fullRestore")).not.toThrow()
})
it("contains a throwing store while saving a tally", async () => {
  const license = service()
  await connect(license)
  vi.spyOn(store, "set").mockImplementation(() => { throw new Error("Store unavailable") })
  expect(() => license.recordTrialUsage(tenant, "fullRestore")).not.toThrow()
  expect(license.trialUsageTally(tenant)).toEqual({ fullRestores: 1 })
})
it("keeps a backfilled usage boundary in memory when its store write fails", async () => {
  const license = service()
  await connect(license)
  const saved = JSON.parse(store.get("license.tenantTrials")!)
  delete saved[tenant].trialFirstSeenAt
  store.set("license.tenantTrials", JSON.stringify(saved))
  const restarted = service()
  await restarted.checkTrialHealth()
  const write = vi.spyOn(store, "set").mockImplementation(() => { throw new Error("Store unavailable") })
  expect(restarted.trialUsagePeriod(tenant)).toEqual({ since: start, until: end })
  vi.setSystemTime(start + day)
  expect(restarted.trialUsagePeriod(tenant)).toEqual({ since: start, until: end })
  expect(write).toHaveBeenCalledOnce()
})
