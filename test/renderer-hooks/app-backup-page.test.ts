import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = vi.fn()
const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]
const state = vi.hoisted(() => ({ selected: 0, fail: false, wait: null as null | (() => Promise<boolean>) }))
const api = vi.hoisted(() => ({ list: vi.fn(), attach: vi.fn(), export: vi.fn(), cancel: vi.fn(async () => {}), chooseStore: vi.fn(async () => false), signIn: vi.fn(async () => {}), deviceStatus: vi.fn(async () => ({ enrollment: "unknown", certificate: "unknown", reason: "Recovery from Intune is not available in this version.", captureAvailable: false })) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { appSources: api } }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ selectedTenant: { id: state.selected, name: state.selected ? "Fabrikam" : "Contoso", credentials: { tenantId: ids[state.selected] } } }) }))
vi.mock("react-router-dom", () => ({ useParams: () => ({ tabId: "versions" }), Link: (props: { to: string; children: React.ReactNode }) => createElement("a", { href: props.to }, props.children) }))
import AppBackupPage from "../../src/renderer/pages/AppBackupPage"
let root: Root | undefined
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function mount() {
 state.fail = false
 api.list.mockImplementation(async (tenant: string) => { if (state.fail) throw new Error("Import the matching recovery key"); return { storeName: "Sources", warnings: [], sources: [{ id: "source", tenantId: tenant, appName: "Finance", fileName: "Finance.intunewin", bytes: 1024, createdAt: "2026-11-12T00:00:00Z", sha256: "abc" }] } })
 api.attach.mockImplementation(() => state.wait ? state.wait() : Promise.resolve(true))
 api.export.mockResolvedValue(true)
 const node = document.createElement("div"); document.body.append(node); root = createRoot(node)
 await act(async () => root!.render(createElement(AppBackupPage))); await flush(); return node
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; state.selected = 0; state.wait = null; vi.clearAllMocks() })
async function click(node: HTMLElement, text: string) {
 const button = [...node.querySelectorAll("button")].find(b => b.textContent?.trim() === text)
 if (!button) throw new Error(`Missing ${text}`)
 await act(async () => button.click()); await flush()
}
describe("App Backup local workspace", () => {
 it("uses App Backup's free Microsoft sign-in before checking the selected tenant", async () => {
  const node = await mount()
  expect(api.signIn).not.toHaveBeenCalled()
  await click(node, "Sign in for device check")
  expect(api.signIn).toHaveBeenCalledExactlyOnceWith(ids[0])
  expect(api.deviceStatus).toHaveBeenCalledWith(ids[0])
 })
 it("clears the previous device result while a new check runs and after it fails", async () => {
  const node = await mount()
  api.deviceStatus.mockResolvedValueOnce({ enrollment: "matched", certificate: "matched", reason: "Previous device observation", captureAvailable: false })
  await click(node, "Check this device")
  expect(node.textContent).toContain("Matching certificate found")
  let fail!: (error: Error) => void
  api.deviceStatus.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  await click(node, "Check this device")
  expect(node.textContent).not.toContain("Matching certificate found")
  expect(node.textContent).not.toContain("Previous device observation")
  expect(node.textContent).toContain("Checking device metadata")
  await act(async () => fail(new Error("Device probe failed"))); await flush()
  expect(node.textContent).toContain("Device probe failed")
  expect(node.textContent).not.toContain("Previous device observation")
 })
 it.each(["success", "failure"])("ignores an older same-tenant list %s after a fresh post-attach reload", async mode => {
  const node = await mount()
  let finish!: (value: unknown) => void, fail!: (error: Error) => void
  const old = new Promise((resolve, reject) => { finish = resolve; fail = reject })
  api.list.mockImplementationOnce(() => old).mockResolvedValueOnce({ storeName: "Sources", warnings: [], sources: [{ id: "new-source", tenantId: ids[0], appName: "New package", fileName: "New.intunewin", bytes: 1024, createdAt: "2026-11-12T00:00:00Z", sha256: "abc" }] })
  await click(node, "Refresh")
  await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) }); await flush()
  expect(node.textContent).toContain("New.intunewin")
  await act(async () => { if (mode === "failure") fail(new Error("stale failure")); else finish({ storeName: "Old", sources: [], warnings: [] }) }); await flush()
  expect(node.textContent).toContain("New.intunewin")
  expect(node.textContent).not.toContain("stale failure")
  expect(node.textContent).not.toContain("Reading the source store")
 })
 it("lists and exports without license or backup-history queries, with honest unknown coverage and unavailable recovery", async () => {
  const node = await mount()
  expect(node.textContent).toContain("Finance.intunewin")
  expect(node.textContent).toContain("Source coverage unavailable")
  expect(node.textContent).toContain("App Backup is completely free")
  await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) }); await flush()
  expect(api.attach).toHaveBeenCalledWith(ids[0], expect.any(String), "")
  expect(api.signIn).not.toHaveBeenCalled()
  expect(node.textContent).toContain("Administrator selected")
  expect(node.textContent).toContain("Recovery from Intune is not available")
  expect(node.textContent).not.toContain("Ready to recover")
  await click(node, "Export original")
  expect(api.export).toHaveBeenCalledWith(ids[0], expect.any(String), "source")
 })
 it("keeps a store failure separate from device check availability", async () => {
  const node = await mount(); state.fail = true
  await click(node, "Refresh")
  expect(node.textContent).toContain("Import the matching recovery key")
  expect(node.textContent).toContain("Reconnect source store")
  expect(node.textContent).toContain("The source store is unavailable")
  expect(node.textContent).not.toContain("No stored installers")
  await click(node, "Check this device")
  expect(api.deviceStatus).toHaveBeenCalledWith(ids[0])
 })
 it("cancels an old tenant's operation on switch and does not show its eventual success on the new tenant", async () => {
  let resolve!: (value: boolean) => void
  state.wait = () => new Promise(r => { resolve = r })
  const node = await mount()
  await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) })
  expect(node.textContent).toContain("Source operation in progress")
  state.selected = 1
  await act(async () => root!.render(createElement(AppBackupPage))); await flush()
  expect(api.cancel).toHaveBeenCalledWith(ids[0], expect.any(String))
  await act(async () => resolve(true)); await flush()
  expect(node.textContent).not.toContain("Original package stored")
  expect(api.list).toHaveBeenLastCalledWith(ids[1])
 })
})
