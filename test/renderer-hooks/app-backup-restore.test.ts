import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { AppRestoreReview, CapturedAppSource } from "../../src/shared/app-sources/types"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const tenant = "11111111-1111-1111-1111-111111111111", target = "22222222-2222-2222-2222-222222222222"
const api = vi.hoisted(() => ({ restoreReview: vi.fn(), loadRestoreSettings: vi.fn(), restore: vi.fn(), restoreProgress: vi.fn(), cancel: vi.fn(), accounts: vi.fn(), signIn: vi.fn(), openExternal: vi.fn(), deviceSignIn: vi.fn(), deviceSignInStatus: vi.fn(), cancelDeviceSignIn: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { appSources: api, app: api, auth: api } }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [{ id: 1, name: "Source", credentials: { tenantId: "11111111-1111-1111-1111-111111111111" } }, { id: 2, name: "Destination", credentials: { tenantId: "22222222-2222-2222-2222-222222222222" } }] }))
import { RestoreAppDialog } from "../../src/renderer/features/app-backup/RestoreAppDialog"
const source = { id: "33333333-3333-3333-3333-333333333333", appName: "Finance" } as CapturedAppSource
const review: AppRestoreReview = { settingsHash: "a".repeat(64), observedAt: "2026-11-14T12:00:00Z", currentSettings: false, name: "Finance", version: "1", publisher: "Example", installCommand: "setup.exe", uninstallCommand: "setup.exe /uninstall", runAs: "system", detectionRules: 1, requirementRules: 0, blocker: null }
let root: Root | undefined
beforeEach(() => {
  api.deviceSignIn.mockResolvedValue({ verificationUri: "https://microsoft.com/devicelogin", userCode: "ABCD12345", expiresAt: new Date(Date.now() + 900000).toISOString() }); api.deviceSignInStatus.mockResolvedValue({ status: "waiting" }); api.cancelDeviceSignIn.mockResolvedValue(undefined)
  api.restoreReview.mockResolvedValue(review); api.accounts.mockResolvedValue([{ tenantId: target }]); api.restoreProgress.mockResolvedValue(null); api.cancel.mockResolvedValue(undefined)
  api.restore.mockResolvedValue({ appId: "44444444-4444-4444-4444-444444444444", tenantId: target, name: "Finance (restored)", contentVersion: "1", sourceId: source.id })
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.resetAllMocks() })
async function mount() { const node = document.createElement("div"); document.body.append(node); root = createRoot(node); await act(async () => root!.render(createElement(RestoreAppDialog, { tenant, source, onClose: vi.fn(), onBusy: vi.fn() }))) }
const button = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!
async function selectTarget() { const select = document.querySelector("select")!; await act(async () => { select.value = target; select.dispatchEvent(new Event("change", { bubbles: true })) }) }
async function confirm() { await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click()) }
it("requires explicit destination and acknowledgment before restoring only the reviewed captured source", async () => {
  await mount()
  expect(button("Restore unassigned app").disabled).toBe(true)
  expect((document.querySelector("select") as HTMLSelectElement).value).toBe("")
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
