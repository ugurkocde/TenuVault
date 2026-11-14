import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { CapturedAppSource } from "../../src/shared/app-sources/types"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const tenant = "11111111-1111-1111-1111-111111111111", other = "22222222-2222-2222-2222-222222222222"
const selection = vi.hoisted(() => ({ tenant: "11111111-1111-1111-1111-111111111111" }))
const api = vi.hoisted(() => ({ info: vi.fn(), accounts: vi.fn(), apps: vi.fn(), list: vi.fn(), assignments: vi.fn(), capture: vi.fn(), captureProgress: vi.fn(), openFolder: vi.fn(), export: vi.fn(), cancel: vi.fn(async () => {}) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { app: { info: api.info }, auth: { accounts: api.accounts }, appSources: api } }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ selectedTenant: { name: "Contoso", credentials: { tenantId: selection.tenant } } }) }))
import AppBackupPage from "../../src/renderer/pages/AppBackupPage"
window.scrollTo = vi.fn()
HTMLElement.prototype.scrollIntoView = vi.fn()
let root: Root | undefined
const captured: CapturedAppSource = {
  id: "33333333-3333-3333-3333-333333333333", tenantId: tenant, appName: "Finance", fileName: "new-backup.zip", bytes: 1024, keyId: "a".repeat(32), sha256: "b".repeat(64), createdAt: "2026-11-14T00:00:00Z",
  provenance: "intune-capture", format: "win32-source-zip", receipt: { schema: 1, tenantId: tenant, appId: tenant, appType: "#microsoft.graph.win32LobApp", contentVersion: "3", contentFileId: other, encryptedBytes: 1100, encryptedSha256: "c".repeat(64) },
}
const older = { ...captured, id: "44444444-4444-4444-4444-444444444444", fileName: "older-backup.zip" }
beforeEach(() => {
  selection.tenant = tenant
  api.info.mockResolvedValue({ platform: "win32" })
  api.accounts.mockResolvedValue([{ tenantId: tenant }])
  api.apps.mockResolvedValue({ apps: [{ id: tenant, name: "Finance", installContext: "system" }], fetchedAt: new Date().toISOString() })
  api.assignments.mockImplementation(async () => ({ appId: tenant, checkedAt: new Date().toISOString(), status: "device-targeted", summary: "A device assignment includes this PC.", steps: [], warnings: [], assignments: [] }))
  api.captureProgress.mockResolvedValue(null)
  api.list.mockResolvedValue({ storeName: "Installers", warnings: [], sources: [older, captured] })
  api.capture.mockResolvedValue(captured)
  api.openFolder.mockResolvedValue(undefined)
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.resetAllMocks() })
function app(path: string) {
  return createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null, createElement(Route, { path: "/portal/app-backup/:tabId?", element: createElement(AppBackupPage) })))
}
async function mount(path = "/portal/app-backup") {
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node)
  await act(async () => root!.render(app(path)))
  return node
}
async function click(node: HTMLElement, label: string) {
  const button = [...node.querySelectorAll("button, a")].find(element => element.textContent?.trim() === label) as HTMLElement | undefined
  expect(button, `Missing ${label}`).toBeDefined()
  await act(async () => button!.click())
}
async function capture(node: HTMLElement) { await click(node, "Backup for Finance"); await click(node, "Start backup") }

it("opens the newly captured backup and its own folder, even when app names match", async () => {
  const node = await mount()
  await capture(node)
  expect(node.textContent).toContain("Finance backed up from Intune.")
  expect(node.textContent).toContain("The local folder contains encrypted backup files")
  await click(node, "Open local folder")
  expect(api.openFolder).toHaveBeenCalledExactlyOnceWith(tenant, captured.id)
  await click(node, "View this backup")
  const catalog = node.querySelector('[aria-labelledby="stored-sources-heading"]')!
  expect(catalog.textContent).toContain(captured.fileName)
  expect(catalog.textContent).not.toContain(older.fileName)
  expect(catalog.querySelector("details")?.open).toBe(true)
  expect(document.activeElement).toBe(catalog.querySelector("h3"))
  await click(node, "Open local folder")
  expect(api.openFolder).toHaveBeenLastCalledWith(tenant, captured.id)
  await click(node, "View all backups")
  expect(catalog.textContent).toContain(older.fileName)
})
it("shows a folder-opening error beside the completion actions and allows retry", async () => {
  const node = await mount(); await capture(node)
  let fail!: (error: Error) => void
  api.openFolder.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  await click(node, "Open local folder")
  expect([...node.querySelectorAll("button")].find(button => button.textContent?.includes("Opening folder"))?.disabled).toBe(true)
  await act(async () => fail(new Error("The local backup folder could not be opened.")))
  expect(node.querySelector('[aria-label="Backup Finance"] [role="alert"]')?.textContent).toContain("could not be opened")
  expect(node.textContent).toContain("View this backup")
  await click(node, "Open local folder")
  expect(api.openFolder).toHaveBeenCalledTimes(2)
})
it.each(["Source operation cancelled.", "Installer access denied"])("does not offer a completed backup after %s", async message => {
  api.capture.mockRejectedValueOnce(new Error(message))
  const node = await mount(); await capture(node)
  expect(node.textContent).not.toContain("View this backup")
  expect(node.textContent).not.toContain("Open local folder")
})
it("opens a retained backup offline through its direct link", async () => {
  api.accounts.mockResolvedValue([])
  const node = await mount(`/portal/app-backup/versions?source=${captured.id}`)
  await click(node, "Open local folder")
  expect(api.openFolder).toHaveBeenCalledExactlyOnceWith(tenant, captured.id)
  expect(api.apps).not.toHaveBeenCalled()
  expect(api.capture).not.toHaveBeenCalled()
})
it("does not substitute another backup when a linked source is missing", async () => {
  api.list.mockResolvedValue({ storeName: "Other folder", warnings: [], sources: [older] })
  const node = await mount(`/portal/app-backup/versions?source=${captured.id}`)
  expect(node.textContent).toContain("This backup is unavailable in this tenant’s connected folder")
  expect(node.textContent).not.toContain("Open local folder")
  await click(node, "View all backups")
  expect(node.textContent).toContain(older.fileName)
})
it("does not expose the previous tenant's completion actions after switching tenant", async () => {
  let finish!: (result: CapturedAppSource) => void
  api.capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const node = await mount(); await capture(node)
  selection.tenant = other
  await act(async () => root!.render(app("/portal/app-backup")))
  expect(api.cancel).toHaveBeenCalledWith(tenant, expect.any(String))
  await act(async () => finish(captured))
  expect(node.textContent).not.toContain("View this backup")
  expect(api.openFolder).not.toHaveBeenCalled()
})
