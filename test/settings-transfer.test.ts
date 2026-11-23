import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BackupScheduler } from "../src/main/backup/scheduler"
import { prepareScheduleInput } from "../src/main/backup/schedule-input"
import { BackupScopes } from "../src/main/backup/scopes"
import { PdfBrandingPolicy, PdfBrandingStore, validateBranding, type LogoImage } from "../src/main/pdf-branding"
import { Preferences } from "../src/main/preferences"
import { ModuleSettings } from "../src/main/services/settings"
import { parseSettingsFile, readSettingsFile, SettingsFileError } from "../src/main/settings-transfer/file"
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
    // As the main process wires it: a read without side effects, and the setter's plan rule before saving.
    schedules: {
      list: () => scheduler.stored(),
      set: (input) => {
        prepareScheduleInput({ ...input, enabled: true }, plan(input.tenantId), scheduler.stored().find((schedule) => schedule.tenantId === input.tenantId))
        return scheduler.set(input)
      },
    },
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
  it("round trips the cloud backup second copy target", () => {
    const a = configured()
    const b = configured()
    const key = `renderer.tenuvault_cloud_backup_${TENANT}`
    const secondary = { secondaryStorageAccount: "contosorecovery", secondaryContainer: "backup-copies" }
    a.store.set(key, JSON.stringify({ ...CLOUD, ...secondary }))
    const exported = a.transfer.exportFile({ app: false, tenantIds: [TENANT], connection: false, appearance: "system" })
    expect(JSON.parse(exported).tenants[0].cloudBackup).toMatchObject(secondary)
    const preview = b.transfer.open(exported, "system")
    const id = `${TENANT}:cloudBackup`
    expect(find(preview, id)).toMatchObject({ status: "change", note: expect.stringMatching(/secondary storage account.*secondary container/) })
    expect(preview.skipped).toEqual([])
    b.transfer.apply(preview.importId, [id], "system")
    expect(JSON.parse(b.store.get(key)!)).toMatchObject(secondary)
  })

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
    expect(result.servicesEnabled).toEqual({ [TENANT]: ["conditionalAccess"] })

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
    expect(preview.skipped).toEqual(['Section "alerts"', 'This computer: "wallpaper"', 'This computer: "communityBannerDismissedAt"', 'Tenant aaaa: "favoriteColor"', 'Tenant aaaa: the service "defender"'])
    expect(everyItem(preview).map((item) => item.id)).toEqual(["app:retentionDays", `${TENANT}:service:conditionalAccess`])
    b.transfer.apply(preview.importId, everyItem(preview).map((item) => item.id), "system")
    expect(b.preferences.saved()).toEqual({ retentionDays: 60 })
  })

  it("does not apply either update setting where the organization manages updates", () => {
    const b = machine([{ tenantId: TENANT }], {}, { autoUpdateManaged: true })
    const preview = b.transfer.open(file({ app: { preferences: { autoUpdate: true, nightlyUpdates: true } } }), "system")
    expect(find(preview, "app:autoUpdate")).toMatchObject({ status: "blocked", reason: expect.stringContaining("managed by your organization") })
    expect(find(preview, "app:nightlyUpdates")).toMatchObject({ status: "blocked", reason: expect.stringContaining("managed by your organization") })
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

describe("review integrity", () => {
  it("applies only items of the last preview, even when the file offers more by now", () => {
    const a = configured()
    const b = machine([{ tenantId: OTHER }])
    const preview = b.transfer.open(a.transfer.exportFile({ app: false, tenantIds: [TENANT], connection: false, appearance: "dark" }), "system")
    expect(find(preview, `${TENANT}:schedule`)).toBeUndefined()
    // The tenant is connected after the preview: its items exist now, but the admin never saw them.
    b.store.set("renderer.tenuvault_tenants", tenantList([{ tenantId: OTHER }, { tenantId: TENANT }]))
    expect(() => b.transfer.apply(preview.importId, [`${TENANT}:schedule`], "system")).toThrow("not part of this file")
    expect(b.scheduler.list()).toEqual([])
    // A new preview shows them, and then they can be applied.
    const again = b.transfer.preview(preview.importId, "system")
    expect(find(again, `${TENANT}:schedule`)?.status).toBe("change")
    b.transfer.apply(preview.importId, [`${TENANT}:schedule`], "system")
    expect(b.scheduler.list().map((schedule) => schedule.tenantId)).toEqual([TENANT])
  })

  it("keeps the preview when a value cannot even be shown as text", () => {
    const b = machine([{ tenantId: TENANT }])
    const text = file({ app: { preferences: { retentionDays: 60, keepRunningInTray: { toString: 1 } }, appearance: { toString: null, valueOf: null } }, tenants: [] })
    const preview = b.transfer.open(text, "system")
    expect(find(preview, "app:retentionDays")?.status).toBe("change")
    expect(find(preview, "app:appearance")).toMatchObject({ status: "blocked", next: "Not valid" })
    expect(find(preview, "app:keepRunningInTray")).toMatchObject({ status: "blocked", next: "Not valid" })
  })

  it("refuses a cloud backup setup with a value of the wrong type or shape, before the parser fills in defaults", () => {
    const b = machine([{ tenantId: TENANT }])
    for (const cloudBackup of [
      { ...CLOUD, automationAccount: "aa-tenuvault\nstorageAccount=attacker1" },
      { ...CLOUD, linked: "yes" },
      { ...CLOUD, frequency: "hourly" },
      { ...CLOUD, weekday: 9 },
      { ...CLOUD, time: "25:00" },
      { ...CLOUD, subscriptionId: "not-a-guid" },
      { ...CLOUD, secondaryStorageAccount: "contosorecovery", secondaryContainer: "copies\nkeyVault=injected" },
      { ...CLOUD, secondaryStorageAccount: 1, secondaryContainer: "copies" },
      { ...CLOUD, secondaryStorageAccount: "contosorecovery", secondaryContainer: "bad--container" },
      { ...CLOUD, secondaryStorageAccount: "contosorecovery" },
    ]) {
      const preview = b.transfer.open(file({ tenants: [{ tenantId: TENANT, cloudBackup }] }), "system")
      expect(find(preview, `${TENANT}:cloudBackup`)).toMatchObject({ status: "blocked", reason: "The value in the file is not valid." })
    }
    // Fields this version does not know are left out of what is saved.
    const preview = b.transfer.open(file({ tenants: [{ tenantId: TENANT, cloudBackup: { ...CLOUD, StorageAccount: "attacker1", extra: { nested: true } } }] }), "system")
    b.transfer.apply(preview.importId, [`${TENANT}:cloudBackup`], "system")
    const saved = JSON.parse(b.store.get(`renderer.tenuvault_cloud_backup_${TENANT}`)!)
    expect(saved.storageAccount).toBe("contosobackups")
    expect(saved).not.toHaveProperty("extra")
    expect(saved).not.toHaveProperty("StorageAccount")
  })

  it("names the types a new scope starts and stops backing up, and leaves a scope that stops one unticked", () => {
    const b = machine([{ tenantId: TENANT }])
    b.scopes.set(TENANT, { excluded: ["DeviceConfigurations"] })
    const preview = b.transfer.open(file({ tenants: [{ tenantId: TENANT, backupScope: { excluded: ["CompliancePolicies"] } }] }), "system")
    const scope = find(preview, `${TENANT}:backupScope`)!
    expect(scope.current).toBe(scope.next)
    expect(scope).toMatchObject({ status: "change", selected: false, note: "Starts backing up device configuration profiles.", warning: expect.stringMatching(/^Stops backing up .*compliance/i) })
  })

  it("shows a preferences section that is not valid instead of dropping it", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({ app: { preferences: [90], appearance: "dark" }, tenants: [] }), "system")
    expect(find(preview, "app:preferences")).toMatchObject({ status: "blocked", reason: "The value in the file is not valid." })
    expect(find(preview, "app:appearance")?.status).toBe("change")
  })

  it("does not turn on a daily schedule while the tenant's plan is not known", () => {
    const a = configured()
    a.scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "04:00" })
    const b = machine([{ tenantId: TENANT }], { [TENANT]: null })
    const preview = b.transfer.open(a.transfer.exportFile({ app: false, tenantIds: [TENANT], connection: false, appearance: "dark" }), "system")
    expect(find(preview, `${TENANT}:schedule`)).toMatchObject({ status: "blocked", reason: expect.stringContaining("not known yet") })
    expect(find(preview, `${TENANT}:schedule`)?.feature).toBeUndefined()
  })

  it("skips branding fields from a newer version and still applies the branding", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({ app: { pdfBranding: { companyName: "Contoso", watermark: "Draft" } }, tenants: [] }), "system")
    expect(preview.skipped).toContain('PDF branding: "watermark"')
    expect(find(preview, "app:pdfBranding")?.status).toBe("change")
    b.transfer.apply(preview.importId, ["app:pdfBranding"], "system")
    expect(b.branding.get()).toEqual({ companyName: "Contoso" })
  })

  it("reads the schedules for a preview without reconciling them", () => {
    const store = memoryStore()
    const onFallback = vi.fn()
    // A Community tenant with a daily schedule: reconciling it saves a weekly fallback and sends a notice.
    const scheduler = new BackupScheduler(store, async () => ({ status: "Completed" as const, message: "" }), () => undefined, () => new Date("2026-11-21T10:00:00.000Z"), () => ({ plan: "community", azure: false }), undefined, onFallback)
    store.set("backup.schedules", JSON.stringify({ [TENANT]: { tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00", since: "2026-11-01T00:00:00.000Z", attempts: 0, nextRunAt: null } }))
    const before = store.get("backup.schedules")
    expect(scheduler.stored().map((schedule) => schedule.frequency)).toEqual(["daily"])
    expect(store.get("backup.schedules")).toBe(before)
    expect(onFallback).not.toHaveBeenCalled()
  })

  it("refuses a daily schedule for Community at apply time too, through the schedule rule", () => {
    const a = configured()
    a.scheduler.set({ tenantId: TENANT, enabled: false, frequency: "daily", time: "04:00" })
    const b = machine([{ tenantId: TENANT }], { [TENANT]: "community" })
    const preview = b.transfer.open(a.transfer.exportFile({ app: false, tenantIds: [TENANT], connection: false, appearance: "dark" }), "system")
    // A paused daily schedule is still a daily one: the preview blocks it like an enabled one.
    expect(find(preview, `${TENANT}:schedule`)).toMatchObject({ status: "blocked", feature: "dailySchedule" })
    expect(b.transfer.apply(preview.importId, [`${TENANT}:schedule`], "system").items[0]?.outcome).toBe("failed")
    expect(b.scheduler.list()).toEqual([])
  })
})

describe("reading a settings file from disk", () => {
  const folder = mkdtempSync(join(tmpdir(), "settings-file-"))

  it("reads a file with a byte order mark, and refuses folders and files over the limit", async () => {
    const withBom = join(folder, "bom.json")
    writeFileSync(withBom, `\uFEFF${file({ tenants: [] })}`)
    expect(parseSettingsFile(await readSettingsFile(withBom)).tenants).toEqual([])

    const large = join(folder, "large.json")
    writeFileSync(large, Buffer.alloc(SETTINGS_FILE_LIMIT + 1, 0x20))
    await expect(readSettingsFile(large)).rejects.toThrow("larger than 5 MB")

    const directory = join(folder, "folder.json")
    mkdirSync(directory)
    await expect(readSettingsFile(directory)).rejects.toThrow("Choose a settings file.")
  })
})

describe("changes the preview spells out", () => {
  it("leaves a shorter retention unticked and says it deletes backups of every tenant", () => {
    const b = machine([{ tenantId: TENANT }])
    b.preferences.set({ retentionDays: 90 })
    const shorter = b.transfer.open(file({ app: { preferences: { retentionDays: 7 } }, tenants: [] }), "system")
    expect(find(shorter, "app:retentionDays")).toMatchObject({ status: "change", selected: false, warning: expect.stringContaining("for every tenant on this computer") })
    const longer = b.transfer.open(file({ app: { preferences: { retentionDays: 365 } }, tenants: [] }), "system")
    expect(find(longer, "app:retentionDays")).toMatchObject({ status: "change", selected: true })
    expect(find(longer, "app:retentionDays")?.warning).toBeUndefined()
    b.preferences.set({ retentionDays: 0 })
    const fromForever = b.transfer.open(file({ app: { preferences: { retentionDays: 365 } }, tenants: [] }), "system")
    expect(find(fromForever, "app:retentionDays")?.selected).toBe(false)
  })

  it("does not turn on a daily schedule over a paused daily one while the plan is not known", () => {
    const b = machine([{ tenantId: TENANT }], { [TENANT]: null })
    b.scheduler.set({ tenantId: TENANT, enabled: false, frequency: "daily", time: "02:00" })
    const preview = b.transfer.open(file({ tenants: [{ tenantId: TENANT, schedule: { enabled: true, frequency: "daily", time: "02:00" } }] }), "system")
    expect(find(preview, `${TENANT}:schedule`)).toMatchObject({ status: "blocked", reason: expect.stringContaining("not known yet") })
    // Pausing it stays possible.
    const pause = b.transfer.open(file({ tenants: [{ tenantId: TENANT, schedule: { enabled: false, frequency: "daily", time: "03:00" } }] }), "system")
    expect(find(pause, `${TENANT}:schedule`)?.status).toBe("change")
  })

  it("names what changes in a cloud setup or branding that reads the same, such as a new color or the linked state", () => {
    const a = configured()
    const b = machine([{ tenantId: TENANT }])
    b.store.set(`renderer.tenuvault_cloud_backup_${TENANT}`, JSON.stringify(CLOUD))
    b.branding.set({ companyName: "Contoso", logo: { dataUrl: pngLogo() }, colors: { primary: "#112233" }, footerText: "Internal" })
    a.branding.set({ companyName: "Contoso", logo: { dataUrl: pngLogo() }, colors: { primary: "#445566" }, footerText: "Internal" })
    const exported = JSON.parse(a.transfer.exportFile({ app: true, tenantIds: [TENANT], connection: false, appearance: "dark" }))
    exported.tenants[0].cloudBackup = { ...CLOUD, linked: false }
    const preview = b.transfer.open(JSON.stringify(exported), "system")
    const cloud = find(preview, `${TENANT}:cloudBackup`)!
    expect(cloud.next).toContain("schedule not linked yet")
    expect(cloud.note).toContain("Changes the linked schedule from yes to no.")
    const branding = find(preview, "app:pdfBranding")!
    expect(branding.status).toBe("change")
    expect(branding.next).toBe(branding.current)
    expect(branding.note).toBe('Changes the colors from primary "#112233" to primary "#445566".')
  })

  it("lists unknown fields inside known parts and still applies the known ones", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({ tenants: [
      { tenantId: TENANT, schedule: { enabled: true, frequency: "weekly", time: "02:00", weekday: 1, jitter: 5 }, cloudBackup: { ...CLOUD, region: "westeurope" }, backupScope: { excluded: [], includeArchived: true } },
      { tenantId: OTHER, name: "Fabrikam", connection: { clientId: CLIENT, storage: { kind: "local", path: "C:\\x" }, tenantHint: "x" } },
    ] }), "system")
    expect(preview.skipped).toEqual(expect.arrayContaining([
      'Tenant aaaa: backup schedule: "jitter"',
      'Tenant aaaa: cloud backup setup: "region"',
      'Tenant aaaa: what is backed up: "includeArchived"',
      'Fabrikam: connection details: "tenantHint"',
      'Fabrikam: storage: "path"',
    ]))
    expect(find(preview, `${TENANT}:schedule`)?.status).toBe("change")
    expect(find(preview, `${TENANT}:cloudBackup`)?.status).toBe("change")
  })
})

describe("services, unknown fields and connection details in the preview", () => {
  it("leaves turning off a backed up service unticked, with a warning", () => {
    const b = machine([{ tenantId: TENANT }])
    b.modules.set(TENANT, "conditionalAccess", true)
    const preview = b.transfer.open(file({ tenants: [{ tenantId: TENANT, services: { conditionalAccess: { enabled: false } } }] }), "system")
    expect(find(preview, `${TENANT}:service:conditionalAccess`)).toMatchObject({ status: "change", selected: false, warning: expect.stringContaining("no longer backed up") })
  })

  it("lists unknown fields inside services and branding colors, and for tenants that are not connected", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({
      app: { pdfBranding: { companyName: "Contoso", colors: { primary: "#112233", secondary: "#445566" } } },
      tenants: [
        { tenantId: TENANT, services: { conditionalAccess: { enabled: true, connection: "beta" } } },
        { tenantId: OTHER, name: "Fabrikam", schedule: { enabled: true, frequency: "weekly", time: "02:00", weekday: 1, jitter: 5 }, backupScope: { excluded: [], extra: 1 }, cloudBackup: { ...CLOUD, region: "x" } },
      ],
    }), "system")
    expect(preview.skipped).toEqual(expect.arrayContaining([
      'PDF branding colors: "secondary"',
      'Tenant aaaa: Entra Conditional Access: "connection"',
      'Fabrikam: backup schedule: "jitter"',
      'Fabrikam: what is backed up: "extra"',
      'Fabrikam: cloud backup setup: "region"',
    ]))
    expect(find(preview, "app:pdfBranding")?.status).toBe("change")
    expect(find(preview, `${TENANT}:service:conditionalAccess`)?.status).toBe("change")
  })

  it("shows connection details that are not valid as a blocked row, for connected tenants and others", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({ tenants: [
      { tenantId: TENANT, connection: { clientId: "not-a-guid" } },
      { tenantId: OTHER, name: "Fabrikam", connection: { clientId: CLIENT, storage: { kind: "azure", storageAccountName: "Bad Name" } } },
    ] }), "system")
    expect(find(preview, `${TENANT}:connection`)).toMatchObject({ status: "blocked", reason: expect.stringContaining("not valid") })
    expect(find(preview, `${OTHER}:connection`)).toMatchObject({ status: "blocked" })
    expect(preview.groups.find((group) => group.id === OTHER)?.setup).toBeUndefined()
  })
})

describe("what an import does, as reviewed", () => {
  it("refuses an item whose effect changed after the review, and applies the others", () => {
    const b = machine([{ tenantId: TENANT }])
    b.scopes.set(TENANT, { excluded: ["Apps", "CompliancePolicies"] })
    const preview = b.transfer.open(file({ app: { preferences: { retentionDays: 60 } }, tenants: [{ tenantId: TENANT, backupScope: { excluded: ["Apps"] } }] }), "system")
    expect(find(preview, `${TENANT}:backupScope`)?.warning).toBeUndefined()
    // The scope changes on this computer: the same file value would now stop backing up a type.
    b.scopes.set(TENANT, { excluded: [] })
    const result = b.transfer.apply(preview.importId, ["app:retentionDays", `${TENANT}:backupScope`], "system")
    expect(result.items).toEqual([
      { id: "app:retentionDays", group: "app", label: "Keep backups for", outcome: "applied" },
      expect.objectContaining({ id: `${TENANT}:backupScope`, outcome: "failed", message: expect.stringContaining("changed since you reviewed it") }),
    ])
    expect(b.scopes.get(TENANT).scope.excluded).toEqual([])
  })

  it("names old and new values in the notes, and whether a logo is added", () => {
    const b = machine([{ tenantId: TENANT }])
    b.branding.set({ companyName: "Contoso", footerText: "Internal" })
    const preview = b.transfer.open(file({ app: { pdfBranding: { companyName: "Contoso", footerText: "Public", logo: { dataUrl: pngLogo() } } }, tenants: [] }), "system")
    expect(find(preview, "app:pdfBranding")?.note).toBe('Changes the logo (added); the footer text from "Internal" to "Public".')
  })

  it("says retention applies to every tenant, and names the Community limit on a computer with a Pro tenant too", () => {
    const b = machine([{ tenantId: TENANT }, { tenantId: OTHER }], { [TENANT]: "pro", [OTHER]: "community" })
    const preview = b.transfer.open(file({ app: { preferences: { retentionDays: 365 } }, tenants: [] }), "system")
    const item = find(preview, "app:retentionDays")!
    expect(item.note).toBe("Applies to every tenant on this computer. On Community, TenuVault keeps at most 30 days.")
    expect(item.feature).toBeUndefined()
  })

  it("keeps a value the file sets on purpose that only matches the default here", () => {
    const b = machine([{ tenantId: TENANT }])
    const preview = b.transfer.open(file({ app: { preferences: { keepRunningInTray: true } }, tenants: [] }), "system")
    expect(find(preview, "app:keepRunningInTray")).toMatchObject({ status: "change", current: "On", next: "On", note: expect.stringContaining("default") })
    b.transfer.apply(preview.importId, ["app:keepRunningInTray"], "system")
    expect(b.preferences.saved()).toEqual({ keepRunningInTray: true })
    const again = b.transfer.open(file({ app: { preferences: { keepRunningInTray: true } }, tenants: [] }), "system")
    expect(find(again, "app:keepRunningInTray")?.status).toBe("same")
  })

  it("names the first unknown parts and counts the rest", () => {
    const b = machine([{ tenantId: TENANT }])
    const unknown = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`future${index}`, 1]))
    const preview = b.transfer.open(file({ ...unknown, tenants: [] }), "system")
    expect(preview.skipped).toHaveLength(51)
    expect(preview.skipped.at(-1)).toBe("And 30 more")
  })
})

describe("apply integrity against stored values", () => {
  it("refuses branding that changed after the review even where the preview text shortens it", () => {
    const b = machine([{ tenantId: TENANT }])
    const footer = "F".repeat(100)
    b.branding.set({ companyName: "Contoso", footerText: `${footer}-old` })
    const preview = b.transfer.open(file({ app: { pdfBranding: { companyName: "Contoso", footerText: "Public" } }, tenants: [] }), "system")
    b.branding.set({ companyName: "Contoso", footerText: `${footer}-new` })
    const result = b.transfer.apply(preview.importId, ["app:pdfBranding"], "system")
    expect(result.items[0]).toMatchObject({ outcome: "failed", message: expect.stringContaining("changed since you reviewed it") })
    expect(b.branding.get()?.footerText).toBe(`${footer}-new`)
  })

  it("reports for the permission check only the services an import turned on", () => {
    const b = machine([{ tenantId: TENANT }])
    b.modules.set(TENANT, "conditionalAccess", true)
    const preview = b.transfer.open(file({ tenants: [{ tenantId: TENANT, services: { conditionalAccess: { enabled: false } } }] }), "system")
    const result = b.transfer.apply(preview.importId, [`${TENANT}:service:conditionalAccess`], "system")
    expect(result.items[0]?.outcome).toBe("applied")
    expect(result.servicesEnabled).toEqual({})
  })
})

describe("update channel and Azure names", () => {
  it("warns that turning automatic updates back on resumes nightly builds, and leaves it unticked", () => {
    const b = machine([{ tenantId: TENANT }])
    b.preferences.set({ autoUpdate: false, nightlyUpdates: true })
    const preview = b.transfer.open(file({ app: { preferences: { autoUpdate: true } }, tenants: [] }), "system")
    expect(find(preview, "app:autoUpdate")).toMatchObject({ status: "change", selected: false, warning: expect.stringContaining("nightly builds") })
  })

  it("connects a tenant whose resource group has a non-ASCII name, from its own export", () => {
    const a = machine([{ tenantId: TENANT, storage: "azure" }])
    const tenants = JSON.parse(a.store.get("renderer.tenuvault_tenants")!)
    tenants[0].resources.resourceGroupName = "rg-münchen"
    a.store.set("renderer.tenuvault_tenants", JSON.stringify(tenants))
    const b = machine([{ tenantId: OTHER }])
    const preview = b.transfer.open(a.transfer.exportFile({ app: false, tenantIds: [TENANT], connection: true, appearance: "system" }), "system")
    expect(preview.groups.find((group) => group.id === TENANT)?.setup?.storage).toMatchObject({ kind: "azure", resourceGroupName: "rg-münchen" })
  })
})

describe("schedules as the scheduler runs them", () => {
  it("says a daily schedule runs weekly on Community, and that Azure storage pauses it there", () => {
    const local = machine([{ tenantId: TENANT }], { [TENANT]: "community" })
    local.scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    const daily = local.transfer.open(file({ tenants: [{ tenantId: TENANT, schedule: { enabled: true, frequency: "daily", time: "04:00" } }] }), "system")
    expect(find(daily, `${TENANT}:schedule`)).toMatchObject({ status: "change", note: "On Community, a daily schedule runs once a week." })
    const azure = machine([{ tenantId: TENANT, storage: "azure" }], { [TENANT]: "community" })
    const weekly = azure.transfer.open(file({ tenants: [{ tenantId: TENANT, schedule: { enabled: true, frequency: "weekly", time: "04:00", weekday: 2 } }] }), "system")
    expect(find(weekly, `${TENANT}:schedule`)?.note).toContain("paused until it is on Pro or MSP")
  })
})
