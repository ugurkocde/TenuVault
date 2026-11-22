import { describe, expect, it } from "vitest"
import { BackupScheduler } from "../src/main/backup/scheduler"
import { BackupScopes } from "../src/main/backup/scopes"
import { PdfBrandingPolicy, PdfBrandingStore, validateBranding, type LogoImage } from "../src/main/pdf-branding"
import { Preferences } from "../src/main/preferences"
import { ModuleSettings } from "../src/main/services/settings"
import { parseSettingsFile, SettingsFileError } from "../src/main/settings-transfer/file"
import { SettingsTransfer } from "../src/main/settings-transfer/service"
import type { Plan } from "../src/shared/plans"
import { SETTINGS_FILE_KIND, SETTINGS_FILE_LIMIT, type TransferPreview } from "../src/shared/settings-transfer"
import { memoryStore } from "./helpers"
import { pngLogo } from "./pdf-report-fixtures"

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111"
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222"
const THIRD = "cccccccc-3333-4333-8333-333333333333"
const CLIENT = "dddddddd-4444-4444-8444-444444444444"
const OTHER_CLIENT = "eeeeeeee-5555-4555-8555-555555555555"
const SUBSCRIPTION = "ffffffff-6666-4666-8666-666666666666"

/** A stand-in for nativeImage that encodes a plain PNG of the requested size. */
function fakeImage(width: number, height: number): LogoImage {
  return {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: (size) => fakeImage(size.width, size.height),
    toPNG: () => Buffer.from(pngLogo(width, height).split(",")[1]!, "base64"),
  }
}

interface TenantSetup { tenantId: string; clientId?: string; storage?: "local" | "azure"; clientSecret?: string }

function tenantList(tenants: TenantSetup[]) {
  return JSON.stringify(tenants.map((tenant, index) => ({
    id: index + 1,
    name: `Tenant ${tenant.tenantId.slice(0, 4)}`,
    domain: `${tenant.tenantId.slice(0, 4)}.onmicrosoft.com`,
    credentials: { tenantId: tenant.tenantId, appId: tenant.clientId ?? CLIENT, clientSecret: tenant.clientSecret ?? "ZGVsZWdhdGVk" },
    resources: tenant.storage === "azure"
      ? { storageAccountName: "contosobackups", subscriptionId: SUBSCRIPTION, resourceGroupName: "rg-tenuvault", resourceGroupLocation: "westeurope", automationAccountName: "" }
      : { storageAccountName: `tvlocal-${tenant.tenantId}`, subscriptionId: "local", resourceGroupName: "local", resourceGroupLocation: "" },
  })))
}

/** One computer: the same store classes the main process uses, over an in-memory store. */
function machine(tenants: TenantSetup[], plans: Record<string, Plan | null> = {}, options: { autoUpdateManaged?: boolean; now?: () => Date } = {}) {
  const store = memoryStore()
  store.set("renderer.tenuvault_tenants", tenantList(tenants))
  const plan = (tenantId: string) => (tenantId in plans ? plans[tenantId]! : "pro")
  const preferences = new Preferences(store)
  const modules = new ModuleSettings(store)
  const scopes = new BackupScopes(store)
  const scheduler = new BackupScheduler(store, async () => ({ status: "Completed" as const, message: "" }))
  const branding = new PdfBrandingPolicy(new PdfBrandingStore(store, () => fakeImage(240, 80)), async (id) => plan(id), () => tenants.map((tenant) => plan(tenant.tenantId)))
  const transfer = new SettingsTransfer({
    store,
    preferences,
    autoUpdateManaged: () => options.autoUpdateManaged === true,
    branding: { get: () => branding.get(), set: (value) => branding.set(value), available: () => branding.available(), validate: validateBranding },
    modules,
    scopes,
    schedules: { list: () => scheduler.list(), set: (input) => scheduler.set(input) },
    plan,
    appVersion: "0.6.0",
    now: options.now ?? (() => new Date("2026-11-21T10:00:00.000Z")),
  })
  return { store, preferences, modules, scopes, scheduler, branding, transfer }
}

const everyItem = (preview: TransferPreview) => preview.groups.flatMap((group) => group.items)
const find = (preview: TransferPreview, id: string) => everyItem(preview).find((item) => item.id === id)

const CLOUD = { tenantId: TENANT, subscriptionId: SUBSCRIPTION, resourceGroup: "rg-tenuvault", automationAccount: "aa-tenuvault", storageAccount: "contosobackups", scheduleName: "TenuVaultBackup-aaaaaaaa", frequency: "weekly", time: "03:00", weekday: 0, timeZone: "W. Europe Standard Time", tenantKey: "aaaaaaaa", linked: true }

function configured() {
  const a = machine([{ tenantId: TENANT, storage: "azure" }])
  a.preferences.set({ retentionDays: 90, keepRunningInTray: false, nightlyUpdates: true })
  a.branding.set({ companyName: "Contoso", logo: { dataUrl: pngLogo() }, colors: { primary: "#112233" }, footerText: "Internal" })
  a.modules.set(TENANT, "conditionalAccess", true)
  a.scopes.set(TENANT, { excluded: [] })
  a.scheduler.set({ tenantId: TENANT, enabled: true, frequency: "weekly", time: "02:00", weekday: 1 })
  a.store.set(`renderer.tenuvault_cloud_backup_${TENANT}`, JSON.stringify(CLOUD))
  return a
}

function file(content: Record<string, unknown>) {
  return JSON.stringify({ kind: SETTINGS_FILE_KIND, schemaVersion: 1, exportedAt: "2026-11-20T08:00:00.000Z", appVersion: "0.6.0", ...content })
}

describe("settings file export", () => {
  it("writes a readable, versioned file with only the chosen parts and the preferences the admin set", () => {
    const a = configured()
    const exported = JSON.parse(a.transfer.exportFile({ app: true, tenantIds: [TENANT], connection: false, appearance: "dark" }))
    expect(exported).toMatchObject({ kind: "tenuvault-settings", schemaVersion: 1, exportedAt: "2026-11-21T10:00:00.000Z", appVersion: "0.6.0" })
    expect(exported.app.preferences).toEqual({ retentionDays: 90, keepRunningInTray: false, nightlyUpdates: true })
    expect(exported.app.appearance).toBe("dark")
    expect(exported.app.pdfBranding.companyName).toBe("Contoso")
    expect(exported.tenants).toEqual([{
      tenantId: TENANT,
      name: "Tenant aaaa",
      domain: "aaaa.onmicrosoft.com",
      services: { conditionalAccess: { enabled: true } },
      backupScope: { excluded: [] },
      schedule: { enabled: true, frequency: "weekly", time: "02:00", weekday: 1 },
      cloudBackup: expect.objectContaining({ automationAccount: "aa-tenuvault", storageAccount: "contosobackups" }),
    }])

    const tenantsOnly = JSON.parse(a.transfer.exportFile({ app: false, tenantIds: [TENANT], connection: true, appearance: "dark" }))
    expect(tenantsOnly.app).toBeUndefined()
    expect(tenantsOnly.tenants[0].connection).toEqual({
      clientId: CLIENT,
      storage: { kind: "azure", storageAccountName: "contosobackups", subscriptionId: SUBSCRIPTION, resourceGroupName: "rg-tenuvault", location: "westeurope" },
    })
  })

  it("refuses tenants that are not connected and empty or malformed options", () => {
    const a = configured()
    expect(() => a.transfer.exportFile({ app: false, tenantIds: [OTHER], connection: false, appearance: "system" })).toThrow("connected on this computer")
    expect(() => a.transfer.exportFile({ app: false, tenantIds: [], connection: false, appearance: "system" })).toThrow("Choose what to export")
    expect(() => a.transfer.exportFile({ app: true, tenantIds: ["not-a-guid"], connection: false, appearance: "system" })).toThrow("Choose what to export")
    expect(() => a.transfer.exportFile(null)).toThrow("Choose what to export")
  })

  it("never writes a secret or per-installation value", () => {
    const a = configured()
    const canaries = {
      "license.state": JSON.stringify({ key: "CANARY-LICENSE-KEY", activations: { [TENANT]: { token: "CANARY-ACTIVATION-TOKEN" } } }),
      "license.installId": "CANARY-INSTALL-ID",
      [`msal.${CLIENT}`]: "CANARY-MSAL-CACHE",
      [`auth.account.${TENANT}`]: JSON.stringify({ username: "canary-admin@contoso.com", homeAccountId: "CANARY-HOME-ACCOUNT" }),
      "backup.keyring": JSON.stringify(["CANARY-BACKUP-KEY"]),
      "backup.recovery-exported": "CANARY-FINGERPRINT",
      [`backupReader.${TENANT}`]: JSON.stringify({ active: { privateKeyPem: "CANARY-PRIVATE-KEY" } }),
      "network.proxy-credentials": JSON.stringify({ "proxy:8080": { username: "canary", password: "CANARY-PROXY-PASSWORD" } }),
      "appSources.restoreOwner": "CANARY-RESTORE-OWNER",
      "setupDiagnostics.state": JSON.stringify({ funnelId: "CANARY-FUNNEL" }),
      "disclaimer.acknowledgements": JSON.stringify({ [TENANT]: { account: "CANARY-DISCLAIMER" } }),
      "restore.write-journal": "CANARY-JOURNAL",
      "renderer.tenuvault.onboarding.draft": "CANARY-DRAFT",
    }
    for (const [key, value] of Object.entries(canaries)) a.store.set(key, value)
    a.store.set("renderer.tenuvault_tenants", tenantList([{ tenantId: TENANT, storage: "azure", clientSecret: "CANARY-CLIENT-SECRET" }]))
    a.preferences.set({ communityBannerDismissedAt: "2026-11-01T00:00:00.000Z", trialOfferHiddenTenantIds: [TENANT], firstBackupNoteSeen: true })

    const text = a.transfer.exportFile({ app: true, tenantIds: [TENANT], connection: true, appearance: "system" })
    expect(text).not.toMatch(/CANARY|canary/)
    expect(text).not.toMatch(/communityBannerDismissedAt|trialOfferHiddenTenantIds|firstBackupNoteSeen|clientSecret/)
  })
})

describe("settings file round trip", () => {
  it("applies every item to another computer with the same tenant, and only what was chosen", () => {
    const a = configured()
    const text = a.transfer.exportFile({ app: true, tenantIds: [TENANT], connection: false, appearance: "dark" })
    const b = machine([{ tenantId: TENANT, storage: "azure" }])
    b.scheduler.set({ tenantId: TENANT, enabled: false, frequency: "weekly", time: "05:00", weekday: 3 })
    const before = b.scheduler.list()[0]!

    const preview = b.transfer.open(text, "system")
    expect(preview.groups.map((group) => [group.id, group.connected])).toEqual([["app", true], [TENANT, true]])
    expect(everyItem(preview).every((item) => item.status === "change")).toBe(true)
    // Items with a warning start unselected; the others are selected.
    expect(find(preview, "app:nightlyUpdates")).toMatchObject({ selected: false, warning: expect.any(String) })
    expect(find(preview, `${TENANT}:schedule`)).toMatchObject({ selected: false, warning: expect.stringContaining("backed up twice") })
    expect(find(preview, "app:retentionDays")).toMatchObject({ selected: true, current: "30 days", next: "90 days" })

    const result = b.transfer.apply(preview.importId, everyItem(preview).map((item) => item.id), "system")
    expect(result.items.every((item) => item.outcome === "applied")).toBe(true)
    expect(result.appearance).toBe("dark")
    expect(result.servicesChanged).toEqual([TENANT])

    expect(b.preferences.saved()).toEqual({ retentionDays: 90, keepRunningInTray: false, nightlyUpdates: true })
    expect(b.branding.get()).toEqual(a.branding.get())
    expect(b.modules.enabled(TENANT)).toEqual(["conditionalAccess"])
    expect(b.scopes.get(TENANT)).toEqual({ scope: { excluded: [] }, saved: true })
    expect(JSON.parse(b.store.get(`renderer.tenuvault_cloud_backup_${TENANT}`)!)).toEqual(JSON.parse(a.store.get(`renderer.tenuvault_cloud_backup_${TENANT}`)!))
    const schedule = b.scheduler.list()[0]!
    expect(schedule).toMatchObject({ enabled: true, frequency: "weekly", time: "02:00", weekday: 1 })
    // Run history stays with the computer.
    expect(schedule.lastRunAt).toBe(before.lastRunAt)

    // A second export of the computer now matches the file, so nothing would change.
    const again = b.transfer.open(text, "dark")
    expect(everyItem(again).every((item) => item.status === "same" && !item.selected)).toBe(true)
  })

  it("applies only the selected items", () => {
    const a = configured()
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(a.transfer.exportFile({ app: true, tenantIds: [TENANT], connection: false, appearance: "dark" }), "system")
    b.transfer.apply(preview.importId, ["app:retentionDays", `${TENANT}:service:conditionalAccess`], "system")
    expect(b.preferences.saved()).toEqual({ retentionDays: 90 })
    expect(b.modules.enabled(TENANT)).toEqual(["conditionalAccess"])
    expect(b.branding.get()).toBeNull()
    expect(b.scheduler.list()).toEqual([])
    expect(b.scopes.get(TENANT).saved).toBe(false)
  })

  it("refuses unknown, reused and expired imports, and items that were not in the preview", () => {
    const a = configured()
    let now = new Date("2026-11-21T10:00:00.000Z")
    const b = machine([{ tenantId: TENANT }], {}, { now: () => now })
    const transfer = b.transfer
    const text = a.transfer.exportFile({ app: true, tenantIds: [TENANT], connection: false, appearance: "dark" })

    expect(() => transfer.apply("not-open", [], "system")).toThrow("no longer open")
    const preview = transfer.open(text, "system")
    expect(() => transfer.apply(preview.importId, ["app:retentionDays", "app:licenseKey"], "system")).toThrow("not part of this file")
    expect(b.preferences.saved()).toEqual({})
    expect(() => transfer.apply(preview.importId, "app:retentionDays", "system")).toThrow("Choose the settings")

    transfer.apply(preview.importId, ["app:retentionDays"], "system")
    expect(() => transfer.apply(preview.importId, ["app:retentionDays"], "system")).toThrow("no longer open")

    const later = transfer.open(text, "system")
    now = new Date(now.getTime() + 61 * 60 * 1000)
    expect(() => transfer.preview(later.importId, "system")).toThrow("no longer open")
  })

  it("reports items that became the same or failed since the preview", () => {
    const a = configured()
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(a.transfer.exportFile({ app: true, tenantIds: [TENANT], connection: false, appearance: "dark" }), "system")
    b.preferences.set({ retentionDays: 90 })
    const result = b.transfer.apply(preview.importId, ["app:retentionDays", "app:appearance"], "system")
    expect(result.items).toEqual([
      { id: "app:retentionDays", group: "app", label: "Keep backups for", outcome: "skipped", message: "Already the same." },
      { id: "app:appearance", group: "app", label: "Appearance", outcome: "applied" },
    ])
  })
})

describe("settings files that cannot be used", () => {
  const cases: Array<[string, string, string]> = [
    ["not JSON", "{ kind: tenuvault", "not a TenuVault settings file"],
    ["another kind", JSON.stringify({ kind: "tenuvault-backup", schemaVersion: 1 }), "not a TenuVault settings file"],
    ["a JSON array", "[]", "not a TenuVault settings file"],
    ["no version", JSON.stringify({ kind: SETTINGS_FILE_KIND }), "no valid version"],
    ["a version as text", JSON.stringify({ kind: SETTINGS_FILE_KIND, schemaVersion: "1" }), "no valid version"],
    ["version 0", JSON.stringify({ kind: SETTINGS_FILE_KIND, schemaVersion: 0 }), "no valid version"],
    ["a newer version", JSON.stringify({ kind: SETTINGS_FILE_KIND, schemaVersion: 2, appVersion: "0.9.0" }), "newer version of TenuVault (0.9.0). Update TenuVault"],
    ["tenants that are not a list", file({ tenants: { [TENANT]: {} } }), "not a list"],
    ["a tenant without a valid ID", file({ tenants: [{ tenantId: "contoso.onmicrosoft.com" }] }), "no valid tenant ID"],
    ["a tenant listed twice", file({ tenants: [{ tenantId: TENANT }, { tenantId: TENANT.toUpperCase() }] }), "listed twice"],
    ["settings of this computer that are not an object", file({ app: [] }), "not valid"],
    ["more than 5 MB", file({ padding: "x".repeat(SETTINGS_FILE_LIMIT) }), "larger than 5 MB"],
  ]

  it.each(cases)("refuses %s and changes nothing", (_name, text, message) => {
    const b = machine([{ tenantId: TENANT }])
    const before = new Map(b.store.values)
    expect(() => b.transfer.open(text, "system")).toThrow(message)
    expect(() => parseSettingsFile(text)).toThrow(SettingsFileError)
    expect(new Map(b.store.values)).toEqual(before)
  })
})

describe("settings that cannot be applied", () => {
  it("blocks only the item whose value is not valid", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({
      app: {
        preferences: { retentionDays: 5000, keepRunningInTray: "yes", autoUpdate: false },
        appearance: "purple",
        pdfBranding: { companyName: "Contoso", colors: { primary: "blue" } },
      },
      tenants: [{
        tenantId: TENANT,
        services: { conditionalAccess: { enabled: "yes" } },
        backupScope: { excluded: "Apps" },
        schedule: { enabled: true, frequency: "weekly", time: "25:00", weekday: 1 },
        cloudBackup: { tenantId: TENANT, storageAccount: "Not Valid!" },
      }],
    }), "system")
    const blocked = everyItem(preview).filter((item) => item.status === "blocked").map((item) => item.id)
    expect(blocked).toEqual(["app:retentionDays", "app:keepRunningInTray", "app:appearance", "app:pdfBranding", `${TENANT}:service:conditionalAccess`, `${TENANT}:backupScope`, `${TENANT}:schedule`, `${TENANT}:cloudBackup`])
    expect(find(preview, "app:pdfBranding")?.reason).toContain("#RRGGBB")
    expect(everyItem(preview).filter((item) => item.status === "blocked").every((item) => !item.selected)).toBe(true)

    const result = b.transfer.apply(preview.importId, ["app:autoUpdate", "app:retentionDays"], "system")
    expect(result.items.map((item) => item.outcome)).toEqual(["applied", "failed"])
    expect(b.preferences.saved()).toEqual({ autoUpdate: false })
  })

  it("blocks a weekly schedule on a day that does not exist, a scope without any type and a broken logo", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({
      app: { pdfBranding: { companyName: "Contoso", logo: { dataUrl: "data:image/png;base64,AAAA" } } },
      tenants: [{ tenantId: TENANT, schedule: { enabled: true, frequency: "weekly", time: "02:00", weekday: 9 }, backupScope: { excluded: ["ConfigurationPolicies", "DeviceConfigurations", "Apps", ...Array.from({ length: 80 }, (_, i) => `Unknown${i}`)] } }],
    }), "system")
    expect(find(preview, `${TENANT}:schedule`)?.status).toBe("blocked")
    expect(find(preview, "app:pdfBranding")?.status).toBe("blocked")
    // Types this version does not know are left out with a note.
    expect(find(preview, `${TENANT}:backupScope`)?.note).toContain("80 types")
  })

  it("lists parts this version does not know, and never applies them", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({
      alerts: { rules: [] },
      app: { preferences: { retentionDays: 60, communityBannerDismissedAt: "2026-11-01T00:00:00.000Z" }, wallpaper: "x" },
      tenants: [{ tenantId: TENANT, services: { conditionalAccess: { enabled: true }, defender: { enabled: true }, intune: { enabled: false } }, favoriteColor: "red" }],
    }), "system")
    expect(preview.skipped).toEqual(['Section "alerts"', 'This computer: "wallpaper"', 'Tenant aaaa: "favoriteColor"', 'Tenant aaaa: the service "defender"'])
    expect(everyItem(preview).map((item) => item.id)).toEqual(["app:retentionDays", `${TENANT}:service:conditionalAccess`])
    b.transfer.apply(preview.importId, everyItem(preview).map((item) => item.id), "system")
    expect(b.preferences.saved()).toEqual({ retentionDays: 60 })
  })

  it("does not apply automatic updates where the organization manages them", () => {
    const b = machine([{ tenantId: TENANT }], {}, { autoUpdateManaged: true })
    const preview = b.transfer.open(file({ app: { preferences: { autoUpdate: true } } }), "system")
    expect(find(preview, "app:autoUpdate")).toMatchObject({ status: "blocked", reason: expect.stringContaining("managed by your organization") })
  })
})

describe("tenants on the importing computer", () => {
  it("skips tenants that are not connected, keeps other tenants and never writes the tenant list", () => {
    const b = machine([{ tenantId: TENANT }, { tenantId: THIRD }])
    b.modules.set(THIRD, "conditionalAccess", true)
    const tenantsBefore = b.store.get("renderer.tenuvault_tenants")
    const preview = b.transfer.open(file({
      tenants: [
        { tenantId: TENANT, services: { conditionalAccess: { enabled: true } }, connection: { clientId: CLIENT, storage: { kind: "local" } } },
        { tenantId: OTHER, name: "Fabrikam", services: { conditionalAccess: { enabled: true } }, connection: { clientId: OTHER_CLIENT, storage: { kind: "azure", storageAccountName: "fabrikambackups", subscriptionId: SUBSCRIPTION, resourceGroupName: "rg", location: "westeurope" } } },
      ],
    }), "system")
    const other = preview.groups.find((group) => group.id === OTHER)!
    expect(other).toMatchObject({ connected: false, items: [], notice: expect.stringContaining("not connected"), setup: { tenantId: OTHER, name: "Fabrikam", clientId: OTHER_CLIENT, storage: { kind: "azure", storageAccountName: "fabrikambackups" } } })
    // A connected tenant gets no setup, and the same storage is not listed.
    expect(preview.groups.find((group) => group.id === TENANT)).toMatchObject({ connected: true })
    expect(preview.groups.find((group) => group.id === TENANT)?.setup).toBeUndefined()
    expect(find(preview, `${TENANT}:storage`)).toBeUndefined()
    expect(() => b.transfer.apply(preview.importId, [`${OTHER}:service:conditionalAccess`], "system")).toThrow("not part of this file")

    b.transfer.apply(preview.importId, everyItem(preview).map((item) => item.id), "system")
    expect(b.modules.enabled(OTHER)).toEqual([])
    expect(b.modules.enabled(THIRD)).toEqual(["conditionalAccess"])
    expect(b.store.get("renderer.tenuvault_tenants")).toBe(tenantsBefore)
  })

  it("shows a different storage target or app registration without changing them", () => {
    const b = machine([{ tenantId: TENANT, clientId: OTHER_CLIENT }])
    const preview = b.transfer.open(file({
      tenants: [{ tenantId: TENANT, connection: { clientId: CLIENT, storage: { kind: "azure", storageAccountName: "contosobackups", subscriptionId: SUBSCRIPTION, resourceGroupName: "rg-tenuvault", location: "westeurope" } } }],
    }), "system")
    const group = preview.groups[0]!
    expect(group.notice).toContain(CLIENT)
    expect(find(preview, `${TENANT}:storage`)).toMatchObject({ status: "blocked", current: "This computer", next: "Azure storage account contosobackups", reason: expect.stringContaining("Change storage") })
  })

  it("does not offer setup for connection details that are not valid", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({ tenants: [{ tenantId: OTHER, connection: { clientId: CLIENT, storage: { kind: "azure", storageAccountName: "../evil" } } }] }), "system")
    expect(preview.groups[0]!.setup).toBeUndefined()
  })

  it("does not apply a cloud backup setup that belongs to another tenant", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({ tenants: [{ tenantId: TENANT, cloudBackup: { ...CLOUD, tenantId: OTHER } }] }), "system")
    expect(find(preview, `${TENANT}:cloudBackup`)).toMatchObject({ status: "blocked", reason: expect.stringContaining("another tenant") })
  })
})

describe("plans on the importing computer", () => {
  const branded = file({ app: { preferences: { retentionDays: 365 }, pdfBranding: { companyName: "Contoso" } }, tenants: [{ tenantId: TENANT, schedule: { enabled: true, frequency: "daily", time: "02:00" } }] })

  it("keeps the Community rules: no daily schedule, no branding, retention saved but applied up to 30 days", () => {
    const b = machine([{ tenantId: TENANT }], { [TENANT]: "community" })
    const preview = b.transfer.open(branded, "system")
    expect(find(preview, `${TENANT}:schedule`)).toMatchObject({ status: "blocked", feature: "dailySchedule" })
    expect(find(preview, "app:pdfBranding")).toMatchObject({ status: "blocked", feature: "pdfBranding" })
    expect(find(preview, "app:retentionDays")).toMatchObject({ status: "change", feature: "customRetention", note: expect.stringContaining("30 days"), selected: true })
    const result = b.transfer.apply(preview.importId, everyItem(preview).map((item) => item.id), "system")
    expect(result.items.map((item) => [item.id, item.outcome])).toEqual([["app:retentionDays", "applied"], ["app:pdfBranding", "failed"], [`${TENANT}:schedule`, "failed"]])
    expect(b.scheduler.list()).toEqual([])
    expect(b.branding.get()).toBeNull()
  })

  it("lets a Community tenant keep editing a daily schedule it already has", () => {
    const b = machine([{ tenantId: TENANT }], { [TENANT]: "pro" })
    b.scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "04:00" })
    const community = machine([{ tenantId: TENANT }], { [TENANT]: "community" })
    community.store.set("backup.schedules", b.store.get("backup.schedules")!)
    expect(find(community.transfer.open(branded, "system"), `${TENANT}:schedule`)?.status).toBe("change")
  })

  it.each<[string, Record<string, Plan | null>]>([
    ["Community and Pro trial", { [TENANT]: "community", [OTHER]: "pro" }],
    ["Community, expired and MSP", { [TENANT]: "community", [OTHER]: null, [THIRD]: "msp" }],
  ])("applies branding when any tenant on the computer includes it (%s)", (_name, plans) => {
    const b = machine(Object.keys(plans).map((tenantId) => ({ tenantId })), plans)
    const preview = b.transfer.open(branded, "system")
    expect(find(preview, "app:pdfBranding")?.status).toBe("change")
    expect(find(preview, "app:retentionDays")?.feature).toBeUndefined()
    // The schedule follows the plan of its own tenant.
    expect(find(preview, `${TENANT}:schedule`)?.feature).toBe("dailySchedule")
  })

  it.each<[string, Record<string, Plan | null>]>([
    ["Community and expired", { [TENANT]: "community", [OTHER]: null }],
    ["Community, expired and unknown", { [TENANT]: "community", [OTHER]: null, [THIRD]: null }],
  ])("blocks branding when no tenant includes it (%s)", (_name, plans) => {
    const b = machine(Object.keys(plans).map((tenantId) => ({ tenantId })), plans)
    expect(find(b.transfer.open(branded, "system"), "app:pdfBranding")).toMatchObject({ status: "blocked", feature: "pdfBranding" })
  })
})
