import { generateKeyPairSync, sign } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BackupScheduler } from "../src/main/backup/scheduler"
import { BackupScopes } from "../src/main/backup/scopes"
import { LicenseService } from "../src/main/license/service"
import { PdfBrandingPolicy, PdfBrandingStore, validateBranding } from "../src/main/pdf-branding"
import { Preferences } from "../src/main/preferences"
import { ModuleSettings } from "../src/main/services/settings"
import { SettingsTransfer } from "../src/main/settings-transfer/service"
import { SETTINGS_FILE_KIND, type TransferPreview } from "../src/shared/settings-transfer"
import { memoryStore } from "./helpers"

// Plan gates of a settings import with the plans the real LicenseService gives: a Pro trial, a
// Pro key, a trial that ended and the Community tenant, on computers with two and three tenants.
const TRIAL = "11111111-1111-4111-8111-111111111111"
const KEYED = "22222222-2222-4222-8222-222222222222"
const ENDED = "33333333-3333-4333-8333-333333333333"
const COMMUNITY = "44444444-4444-4444-8444-444444444444"
const INSTALL = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f"
const KEY = "LICENSE-KEY-SETTINGS"
const START = Date.UTC(2026, 10, 10)
const DAY = 86_400_000
const { publicKey, privateKey } = generateKeyPairSync("ed25519")

function grant(tenantId: string, source: "trial" | "key", endsAt: number) {
  const trial = source === "trial"
  const id = tenantId.replaceAll("-", "")
  const activationId = trial ? `trial-${id}` : `key-${tenantId}`
  const payload = {
    v: 2, sub: trial ? `trial:${id.slice(0, 16)}` : KEY, act: activationId, plan: "pro", tenants: 2, tenantId, installId: INSTALL,
    status: "granted", iat: Date.now() / 1000, exp: endsAt / 1000, ...(trial ? { trial: true, keyExp: endsAt / 1000 } : {}),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const token = `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`
  return Response.json({ token, activationId, source, ...(trial ? { trial: true, keyExp: payload.keyExp, canEnd: true } : {}) })
}

async function computer(tenants: string[]) {
  const store = memoryStore()
  store.set("license.installId", INSTALL)
  store.set("renderer.tenuvault_tenants", JSON.stringify(tenants.map((tenantId, index) => ({ id: index, name: tenantId.slice(0, 4), credentials: { tenantId, appId: KEYED, clientSecret: "x" }, resources: { storageAccountName: `tvlocal-${tenantId}` } }))))
  const license = new LicenseService({
    store,
    persist: true,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    apiBase: "https://www.tenuvault.com",
    appVersion: "0.6.0",
    initialTenantIds: [],
    connectedTenantIds: () => tenants,
    idToken: async (tenantId) => tenantId,
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname.split("/").at(-1)
      if (path === "health") return Response.json({ tenantTrials: { enabled: true, ok: true } })
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (path === "activate" && body.key === KEY && body.tenantId === KEYED) return grant(KEYED, "key", Date.now() + 365 * DAY)
      if (path === "activate") return Response.json({ reason: "tenant_not_licensed" }, { status: 403 })
      if (path === "tenant" && (body.action === "start_trial" || body.action === "refresh")) {
        const tenant = String(body.idToken)
        const end = tenant === ENDED ? START + 2 * DAY : START + 14 * DAY
        if (Date.now() >= end) return Response.json({ reason: "expired" }, { status: 403 })
        return grant(tenant, "trial", end)
      }
      if (path === "tenant") return Response.json({ reason: "tenant_not_licensed" }, { status: 403 })
      throw new Error(`Unexpected licensing request: ${path}`)
    },
  })
  await license.checkTrialHealth()
  if (tenants.includes(TRIAL)) await license.checkNewTenant(TRIAL)
  if (tenants.includes(ENDED)) await license.checkNewTenant(ENDED)
  if (tenants.includes(KEYED)) await license.setKey(KEY, [KEYED])
  if (tenants.includes(COMMUNITY)) store.set("license.communityTenant", COMMUNITY)

  const scheduler = new BackupScheduler(store, async () => ({ status: "Completed" as const, message: "" }))
  const branding = new PdfBrandingPolicy(new PdfBrandingStore(store, () => { throw new Error("no logo in this test") }), async (id) => license.plan(id), () => tenants.map((id) => license.plan(id)))
  const transfer = new SettingsTransfer({
    store,
    preferences: new Preferences(store),
    autoUpdateManaged: () => false,
    branding: { get: () => branding.get(), set: (value) => branding.set(value), available: () => branding.available(), validate: validateBranding },
    modules: new ModuleSettings(store),
    scopes: new BackupScopes(store),
    schedules: { list: () => scheduler.list(), set: (input) => scheduler.set(input) },
    plan: (tenantId) => license.plan(tenantId),
    appVersion: "0.6.0",
  })
  return { license, transfer, scheduler, branding }
}

const fileFor = (tenants: string[]) => JSON.stringify({
  kind: SETTINGS_FILE_KIND,
  schemaVersion: 1,
  app: { preferences: { retentionDays: 365 }, pdfBranding: { companyName: "Contoso" } },
  tenants: tenants.map((tenantId) => ({ tenantId, schedule: { enabled: true, frequency: "daily", time: "02:00" } })),
})
const item = (preview: TransferPreview, id: string) => preview.groups.flatMap((group) => group.items).find((entry) => entry.id === id)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(START)
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("settings import with LicenseService plans", () => {
  it("two tenants, Community and a Pro trial: branding applies, the daily schedule only for the trial tenant", async () => {
    const { license, transfer, scheduler, branding } = await computer([COMMUNITY, TRIAL])
    expect([license.plan(COMMUNITY), license.plan(TRIAL)]).toEqual(["community", "pro"])
    const preview = transfer.open(fileFor([COMMUNITY, TRIAL]), "system")
    expect(item(preview, "app:pdfBranding")?.status).toBe("change")
    expect(item(preview, "app:retentionDays")?.feature).toBeUndefined()
    expect(item(preview, `${COMMUNITY}:schedule`)).toMatchObject({ status: "blocked", feature: "dailySchedule" })
    expect(item(preview, `${TRIAL}:schedule`)?.status).toBe("change")

    transfer.apply(preview.importId, preview.groups.flatMap((group) => group.items.map((entry) => entry.id)), "system")
    expect(scheduler.list().map((schedule) => schedule.tenantId)).toEqual([TRIAL])
    expect(branding.get()?.companyName).toBe("Contoso")
  })

  it("three tenants, a Pro key, a trial that ended and Community: the ended trial blocks nothing it does not own", async () => {
    const { license, transfer } = await computer([KEYED, ENDED, COMMUNITY])
    vi.setSystemTime(START + 3 * DAY)
    expect([license.plan(KEYED), license.plan(ENDED), license.plan(COMMUNITY)]).toEqual(["pro", null, "community"])
    const preview = transfer.open(fileFor([KEYED, ENDED, COMMUNITY]), "system")
    expect(item(preview, "app:pdfBranding")?.status).toBe("change")
    expect(item(preview, `${KEYED}:schedule`)?.status).toBe("change")
    // Without a plan the schedule settings apply no plan rule either; the backup itself is refused then.
    expect(item(preview, `${ENDED}:schedule`)?.status).toBe("change")
    expect(item(preview, `${COMMUNITY}:schedule`)?.feature).toBe("dailySchedule")
  })

  it("two tenants, a trial that ended and Community: no branding, retention saved with the Community note", async () => {
    const { license, transfer } = await computer([ENDED, COMMUNITY])
    vi.setSystemTime(START + 3 * DAY)
    expect([license.plan(ENDED), license.plan(COMMUNITY)]).toEqual([null, "community"])
    const preview = transfer.open(fileFor([COMMUNITY]), "system")
    expect(item(preview, "app:pdfBranding")).toMatchObject({ status: "blocked", feature: "pdfBranding" })
    expect(item(preview, "app:retentionDays")).toMatchObject({ status: "change", feature: "customRetention" })
  })
})
