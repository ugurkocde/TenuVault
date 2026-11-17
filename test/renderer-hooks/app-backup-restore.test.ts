import { useConnectLinksHeld } from "../../src/renderer/lib/connect-link-holds"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppRestoreReview, CapturedAppSource } from "../../src/shared/app-sources/types"
import type { LicenseStatus, TenantLicenseStatus } from "../../src/shared/ipc"
import { FeatureApiError } from "../../src/renderer/lib/feature-api"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const tenant = "11111111-1111-1111-1111-111111111111", target = "22222222-2222-2222-2222-222222222222"
const api = vi.hoisted(() => ({ restoreReview: vi.fn(), loadRestoreSettings: vi.fn(), restore: vi.fn(), restoreProgress: vi.fn(), cancel: vi.fn(), accounts: vi.fn(), signIn: vi.fn(), openExternal: vi.fn(), deviceSignIn: vi.fn(), deviceSignInStatus: vi.fn(), cancelDeviceSignIn: vi.fn(), acknowledge: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { appSources: api, app: api, auth: api } }))
vi.mock("../../src/renderer/lib/disclaimer", () => ({ requestAcknowledgement: api.acknowledge }))
const license = vi.hoisted(() => ({ status: null as unknown }))
vi.mock("../../src/renderer/lib/license", async importOriginal => ({ ...await importOriginal<typeof import("../../src/renderer/lib/license")>(), useLicense: () => ({ status: license.status, signedInTenantIds: undefined, refresh: async () => undefined }) }))
const stored = vi.hoisted(() => ({ source: "11111111-1111-1111-1111-111111111111" }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [{ id: 2, name: "Destination", credentials: { tenantId: "22222222-2222-2222-2222-222222222222" } }, { id: 1, name: "Source", credentials: { tenantId: stored.source } }] }))
import { RestoreAppDialog } from "../../src/renderer/features/app-backup/RestoreAppDialog"
const source = { id: "33333333-3333-3333-3333-333333333333", appName: "Finance" } as CapturedAppSource
const review: AppRestoreReview = { settingsHash: "a".repeat(64), observedAt: "2026-11-14T12:00:00Z", currentSettings: false, name: "Finance", version: "1", publisher: "Example", installCommand: "setup.exe", uninstallCommand: "setup.exe /uninstall", runAs: "system", detectionRules: 1, requirementRules: 0, blocker: null }
let root: Root | undefined
function tenantStatus(tenantId: string, plan: TenantLicenseStatus["plan"], entitled: boolean, trial = false) {
  return { tenantId, signedIn: true, activated: entitled, entitled, source: entitled ? (trial ? "trial" : "key") : null, plan, trial } as TenantLicenseStatus
}
function statusWith(destination: TenantLicenseStatus | null, keyPlan: LicenseStatus["plan"] = null) {
  return { hasKey: keyPlan !== null, plan: keyPlan, tenants: [tenantStatus(tenant, "community", false), ...(destination ? [destination] : [])] } as unknown as LicenseStatus
}
beforeEach(() => {
  license.status = statusWith(tenantStatus(target, "pro", true))
  api.deviceSignIn.mockResolvedValue({ verificationUri: "https://microsoft.com/devicelogin", userCode: "ABCD12345", expiresAt: new Date(Date.now() + 900000).toISOString() }); api.deviceSignInStatus.mockResolvedValue({ status: "waiting" }); api.cancelDeviceSignIn.mockResolvedValue(undefined)
  api.restoreReview.mockResolvedValue(review); api.accounts.mockResolvedValue([{ tenantId: target }]); api.restoreProgress.mockResolvedValue(null); api.cancel.mockResolvedValue(undefined)
  api.restore.mockResolvedValue({ appId: "44444444-4444-4444-4444-444444444444", tenantId: target, name: "Finance (restored)", contentVersion: "1", sourceId: source.id })
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.resetAllMocks(); stored.source = tenant })
async function mount(sourceTenant = tenant) { const node = document.createElement("div"); document.body.append(node); root = createRoot(node); await act(async () => root!.render(createElement("div", null, createElement(RestoreAppDialog, { tenant: sourceTenant, source, onClose: vi.fn(), onBusy: vi.fn() }), createElement(ConnectHoldProbe)))) }
const button = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!
async function selectTarget() { const select = document.querySelector("select")!; await act(async () => { select.value = target; select.dispatchEvent(new Event("change", { bubbles: true })) }) }
async function confirm() { await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click()) }
function ConnectHoldProbe() {
  return createElement("p", { id: "connect-held" }, useConnectLinksHeld() ? "held" : "ready")
}

it("holds connection links for the entire installer restore", async () => {
  let finish!: (value: unknown) => void
  api.restore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await mount(); await selectTarget(); await confirm()
  await act(async () => button("Restore unassigned app").click())
  expect(document.querySelector("#connect-held")?.textContent).toBe("held")
  await act(async () => root!.render(createElement(ConnectHoldProbe)))
  expect(document.querySelector("#connect-held")?.textContent).toBe("held")
  await act(async () => finish({ appId: "44444444-4444-4444-4444-444444444444", tenantId: target, name: "Restored", contentVersion: "1", sourceId: source.id }))
  expect(document.querySelector("#connect-held")?.textContent).toBe("ready")
})

it("requires explicit destination and acknowledgment before restoring only the reviewed captured source", async () => {
  await mount()
  expect(button("Restore unassigned app").disabled).toBe(true)
  expect((document.querySelector("select") as HTMLSelectElement).value).toBe(tenant)
  await selectTarget(); expect(button("Restore unassigned app").disabled).toBe(true)
  await confirm(); await act(async () => button("Restore unassigned app").click())
  expect(api.restore).toHaveBeenCalledWith(tenant, expect.any(String), source.id, target, "Finance (restored)", review.settingsHash)
  expect(document.body.textContent).toContain("No assignments were added")
  await act(async () => button("Open restored app").click())
  expect(api.openExternal).toHaveBeenCalledWith(expect.stringContaining(target))
})
it("explains earlier installer-only backups and loads settings only on request", async () => {
  api.restoreReview.mockResolvedValue({ ...review, settingsHash: null }); api.loadRestoreSettings.mockResolvedValue({ ...review, currentSettings: true })
  await mount(); expect(api.loadRestoreSettings).not.toHaveBeenCalled()
  await act(async () => button("Load current app settings").click())
  expect(api.loadRestoreSettings).toHaveBeenCalledWith(tenant, source.id)
  expect(document.body.textContent).toContain("Current source settings loaded")
})
it("uses the existing destination session and requests sign-in only if missing", async () => {
  api.accounts.mockResolvedValueOnce([]).mockResolvedValue([{ tenantId: target }])
  await mount(); await selectTarget(); await confirm()
  expect(button("Restore unassigned app").disabled).toBe(true)
  await act(async () => button("Sign in to destination").click())
  expect(api.signIn).toHaveBeenCalledExactlyOnceWith(target)
  expect(button("Restore unassigned app").disabled).toBe(false)
})
it("cancels with the source tenant on unmount and ignores a late completion", async () => {
  let finish!: (value: unknown) => void; api.restore.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await mount(); await selectTarget(); await confirm(); await act(async () => button("Restore unassigned app").click())
  act(() => root!.unmount()); root = undefined
  expect(api.cancel).toHaveBeenCalledWith(tenant, expect.any(String))
  await act(async () => finish({ appId: target, tenantId: target }))
  expect(document.body.textContent).not.toContain("restored to")
})
it("blocks unsupported settings without offering creation", async () => {
  api.restoreReview.mockResolvedValue({ ...review, blocker: "Destination dependency mapping is required." })
  await mount(); expect(document.body.textContent).toContain("Destination dependency mapping")
  expect(button("Restore unassigned app").disabled).toBe(true); expect(api.restore).not.toHaveBeenCalled()
})
it("offers a code while browser sign-in is pending and ignores the cancelled browser result", async () => {
  api.accounts.mockResolvedValue([])
  let reject!: (error: Error) => void; api.signIn.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  await mount(); await selectTarget(); await act(async () => button("Sign in to destination").click())
  expect(button("Use a device code").disabled).toBe(false)
  await act(async () => button("Use a device code").click())
  expect(api.deviceSignIn).toHaveBeenCalledWith(target); expect(document.body.textContent).toContain("ABCD12345")
  await act(async () => reject(new Error("Browser cancelled")))
  expect(document.body.textContent).not.toContain("Browser cancelled")
  expect(button("Restore unassigned app").disabled).toBe(true)
  act(() => root!.unmount()); root = undefined
  expect(api.cancelDeviceSignIn).toHaveBeenCalledExactlyOnceWith(target)
})
it("refreshes the destination session after Microsoft completes device sign-in", async () => {
  api.accounts.mockResolvedValueOnce([]).mockResolvedValue([{ tenantId: target }]); api.deviceSignInStatus.mockResolvedValue({ status: "completed" })
  await mount(); await selectTarget(); await confirm(); await act(async () => button("Use a device code").click())
  expect(document.body.textContent).not.toContain("ABCD12345"); expect(button("Restore unassigned app").disabled).toBe(false)
})


it("reconnects only the source and retries earlier settings loading after authentication", async () => {
  api.restoreReview.mockResolvedValue({ ...review, settingsHash: null })
  api.loadRestoreSettings.mockRejectedValueOnce(new Error("Sign in to the source first")).mockResolvedValue({ ...review, currentSettings: true })
  api.signIn.mockResolvedValue(undefined)
  await mount(); await act(async () => button("Load current app settings").click())
  expect(document.body.textContent).toContain("Sign in to the source first")
  await act(async () => button("Reconnect source and load settings").click())
  expect(api.signIn).toHaveBeenCalledExactlyOnceWith(tenant)
  expect(api.loadRestoreSettings).toHaveBeenCalledTimes(2)
  expect(api.loadRestoreSettings).toHaveBeenLastCalledWith(tenant, source.id)
  expect(document.body.textContent).toContain("Current source settings loaded")
  expect((document.querySelector("select") as HTMLSelectElement).value).toBe(tenant)
})
it.each([true, false])("retries only after the destination disclaimer is accepted: %s", async accepted => {
  const result = { appId: target, tenantId: target, name: "Restored", contentVersion: "1", sourceId: source.id }
  api.restore.mockResolvedValueOnce({ error: "Accept disclaimer", acknowledgement: { version: 1, tenantIds: [target] } }).mockResolvedValue(result)
  api.acknowledge.mockResolvedValue(accepted)
  await mount(); await selectTarget(); await confirm(); await act(async () => button("Restore unassigned app").click())
  expect(api.acknowledge).toHaveBeenCalledExactlyOnceWith([target])
  expect(api.restore).toHaveBeenCalledTimes(accepted ? 2 : 1)
  expect(document.body.textContent).toContain(accepted ? "No assignments were added" : "No changes were made")
})
it("does not retry after leaving while the disclaimer is pending", async () => {
  let finish!: (value: boolean) => void
  api.acknowledge.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  api.restore.mockResolvedValue({ error: "Accept disclaimer", acknowledgement: { version: 1, tenantIds: [target] } })
  await mount(); await selectTarget(); await confirm(); await act(async () => button("Restore unassigned app").click())
  act(() => root!.unmount()); root = undefined
  await act(async () => finish(true))
  expect(api.restore).toHaveBeenCalledOnce()
})

describe("restore into another tenant on the destination's plan", () => {
  const note = "Restoring into another tenant is included in TenuVault Pro and MSP for that tenant."
  const options = () => [...document.querySelectorAll("option")].map(o => o.textContent)
  it("defaults to the source tenant, lists it first and restores there on Community without a plan note", async () => {
    license.status = statusWith(tenantStatus(target, "community", false))
    api.accounts.mockResolvedValue([{ tenantId: tenant }])
    api.restore.mockResolvedValue({ appId: "44444444-4444-4444-4444-444444444444", tenantId: tenant, name: "Finance (restored)", contentVersion: "1", sourceId: source.id })
    await mount()
    expect((document.querySelector("select") as HTMLSelectElement).value).toBe(tenant)
    expect(options()).toEqual(["Choose a connected tenant…", "Source (source tenant)", "Destination (Pro)"])
    expect(document.body.textContent).not.toContain(note)
    await confirm(); await act(async () => button("Restore unassigned app").click())
    expect(api.restore).toHaveBeenCalledWith(tenant, expect.any(String), source.id, tenant, "Finance (restored)", review.settingsHash)
  })
  it.each([
    ["Community", (): TenantLicenseStatus | null => tenantStatus(target, "community", false), null],
    ["an ended license", (): TenantLicenseStatus | null => tenantStatus(target, null, false), null],
    ["a tenant outside the license", (): TenantLicenseStatus | null => null, null],
    ["no plan on record on a key install", (): TenantLicenseStatus | null => null, "pro"],
  ] as const)("shows the plan note and blocks a restore into another tenant on %s", async (_label, destination, keyPlan) => {
    license.status = statusWith(destination(), keyPlan)
    await mount(); await selectTarget()
    expect(options()).toContain("Destination (Pro)")
    expect(document.body.textContent).toContain(note)
    // The existing Pro prompt of plan notes; outside a router it offers the plans or the checkout.
    expect([...document.querySelectorAll("button")].some(b => ["See plans", "Buy Pro"].includes(b.textContent?.trim() ?? ""))).toBe(true)
    await confirm()
    expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false)
    expect(button("Restore unassigned app").disabled).toBe(true)
    expect(api.restore).not.toHaveBeenCalled()
  })
  it.each([["Pro trial", true, "pro"], ["Pro", false, "pro"], ["MSP", false, "msp"]] as const)("restores into another tenant on %s without a plan note", async (_label, trial, plan) => {
    license.status = statusWith(tenantStatus(target, plan, true, trial))
    await mount(); await selectTarget()
    expect(options()).toContain("Destination")
    expect(document.body.textContent).not.toContain(note)
    await confirm(); await act(async () => button("Restore unassigned app").click())
    expect(api.restore).toHaveBeenCalledWith(tenant, expect.any(String), source.id, target, "Finance (restored)", review.settingsHash)
  })
  it("lower-cases an upper-case stored source tenant ID for the default, the order and the label", async () => {
    const upper = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"
    stored.source = upper
    license.status = statusWith(tenantStatus(target, "community", false))
    api.accounts.mockResolvedValue([{ tenantId: upper.toLowerCase() }])
    await mount(upper)
    expect((document.querySelector("select") as HTMLSelectElement).value).toBe(upper.toLowerCase())
    expect(options()).toEqual(["Choose a connected tenant…", "Source (source tenant)", "Destination (Pro)"])
    expect(document.body.textContent).not.toContain(note)
    await confirm(); await act(async () => button("Restore unassigned app").click())
    expect(api.restore).toHaveBeenCalledWith(upper.toLowerCase(), expect.any(String), source.id, upper.toLowerCase(), "Finance (restored)", review.settingsHash)
  })
  it("shows the plan dialog when the main process refuses another tenant", async () => {
    // The status still shows Pro, but the plan on record changed before the restore started.
    api.restore.mockRejectedValue(new FeatureApiError("Restoring an App Backup installer into another tenant: included in TenuVault Pro and MSP. Upgrade on the License page.", 402, "appRestoreOtherTenant"))
    await mount(); await selectTarget(); await confirm(); await act(async () => button("Restore unassigned app").click())
    expect(document.body.textContent).toContain("Included in TenuVault Pro and MSP")
    expect(document.body.textContent).not.toContain("No assignments were added")
  })
})
