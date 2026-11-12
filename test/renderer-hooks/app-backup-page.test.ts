import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = vi.fn()
const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]
const state = vi.hoisted(() => ({ selected: 0, tab: "versions", empty: false, fail: false, wait: null as null | (() => Promise<boolean>) }))
const api = vi.hoisted(() => ({ info: vi.fn(async () => ({platform:"win32"})), accounts:vi.fn(), apps: vi.fn(), list: vi.fn(), attach: vi.fn(), export: vi.fn(), cancel: vi.fn(async () => {}), chooseStore: vi.fn(async () => false), signIn: vi.fn(async () => {}), deviceStatus: vi.fn(async () => ({ enrollment: "unknown", certificate: "unknown", reason: "Recovery from Intune is not available in this version.", captureAvailable: false })) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { app:{info:api.info}, auth:{accounts:api.accounts}, appSources: api } }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ selectedTenant: { id: state.selected, name: state.selected ? "Fabrikam" : "Contoso", credentials: { tenantId: ids[state.selected] } } }) }))
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({ tabId: state.tab }), Link: (props: { to: string; children: React.ReactNode }) => createElement("a", { href: props.to }, props.children) }))
import AppBackupPage from "../../src/renderer/pages/AppBackupPage"
HTMLElement.prototype.scrollIntoView = vi.fn()
let root: Root | undefined
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function mount() {
 state.fail = false
 api.accounts.mockResolvedValue(ids.map(tenantId => ({tenantId})))
 api.apps.mockResolvedValue({apps:[{id:ids[0],name:"Finance",publisher:"Contoso"}],fetchedAt:"2026-11-12T00:00:00Z"})
 api.list.mockImplementation(async (tenant: string) => { if (state.fail) throw new Error("Import the matching recovery key"); return { storeName: "Sources", warnings: [], sources: state.empty ? [] : [{ id: "source", tenantId: tenant, appName: "Finance", fileName: "Finance.intunewin", bytes: 1024, createdAt: "2026-11-12T00:00:00Z", sha256: "abc" }] } })
 api.attach.mockImplementation(() => state.wait ? state.wait() : Promise.resolve(true))
 api.export.mockResolvedValue(true)
 const node = document.createElement("div"); document.body.append(node); root = createRoot(node)
 await act(async () => root!.render(createElement(AppBackupPage))); await flush(); return node
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; state.selected = 0; state.tab = "versions"; state.empty = false; state.wait = null; vi.clearAllMocks() })
async function click(node: HTMLElement, text: string) {
 const button = [...node.querySelectorAll("button")].find(b => b.textContent?.trim() === text)
 if (!button) throw new Error(`Missing ${text}`)
 await act(async () => button.click()); await flush()
}
describe("App Backup local workspace", () => {
 it("signs in through the free action and checks the selected app's PC without touching the store", async () => {
  state.tab = "apps"
  const node = await mount()
  await click(node, "Backup for Finance")
  api.accounts.mockResolvedValueOnce([])
  await click(node, "Check Windows enrollment")
  expect(api.signIn).toHaveBeenCalledExactlyOnceWith(ids[0])
  expect(api.deviceStatus).toHaveBeenCalledWith(ids[0])
  expect(api.attach).not.toHaveBeenCalled()
 })
 it("clears a previous device observation when checking again and after failure", async () => {
  state.tab = "apps"
  const node = await mount()
  await click(node, "Backup for Finance")
  api.deviceStatus.mockResolvedValueOnce({ enrollment: "matched", certificate: "matched", reason: "Previous device observation", captureAvailable: false })
  await click(node, "Check Windows enrollment")
  expect(node.textContent).toContain("Matching certificate found")
  let fail!: (error: Error) => void
  api.deviceStatus.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  await click(node, "Check Windows enrollment")
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
  expect(node.textContent).toContain("Saved installers")
  expect(node.textContent).toContain("Free encrypted installer storage")
  await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) }); await flush()
  expect(api.attach).toHaveBeenCalledWith(ids[0], expect.any(String), "")
  expect(api.signIn).not.toHaveBeenCalled()
  expect(node.textContent).toContain("Administrator selected")
  expect(node.textContent).toContain("Saved installers")
  expect(node.textContent).not.toContain("Ready to recover")
  await click(node, "Export original")
  expect(api.export).toHaveBeenCalledWith(ids[0], expect.any(String), "source")
 })
 it("keeps a store failure separate from device check availability", async () => {
  const node = await mount(); state.fail = true
  await click(node, "Refresh")
  expect(node.textContent).toContain("Import the matching recovery key")
  expect(node.textContent).toContain("Choose installer folder")
  expect(node.textContent).toContain("The source store is unavailable")
  expect(node.textContent).not.toContain("No stored installers")
  expect(node.textContent).toContain("Saved installers")
 })
 it("cancels an old tenant's operation on switch and does not show its eventual success on the new tenant", async () => {
  let resolve!: (value: boolean) => void
  state.wait = () => new Promise(r => { resolve = r })
  const node = await mount()
  await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) })
  expect(node.textContent).toContain("Saving installer…")
  state.selected = 1
  await act(async () => root!.render(createElement(AppBackupPage))); await flush()
  expect(api.cancel).toHaveBeenCalledWith(ids[0], expect.any(String))
  await act(async () => resolve(true)); await flush()
  expect(node.textContent).not.toContain("Installer saved")
  expect(api.list).toHaveBeenLastCalledWith(ids[1])
 })
})

it("makes saving visible immediately when the installer folder is empty", async () => {
 state.empty = true
 const node = await mount()
 expect(node.querySelector("form")!.closest("details")!.open).toBe(true)
 expect(node.textContent).toContain("No saved installers yet")
 expect([...node.querySelectorAll("button")].some(button => button.textContent?.trim() === "Save installer")).toBe(true)
})
it("keeps an operation failure when an older catalog refresh completes", async () => {
 const node = await mount()
 let finish!: (value: unknown) => void
 api.list.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
 await click(node, "Refresh")
 api.attach.mockRejectedValueOnce(new Error("Invalid installer package"))
 await act(async () => {node.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}))}); await flush()
 expect(node.textContent).toContain("Invalid installer package")
 await act(async () => finish({storeName:"Sources",warnings:[],sources:[]})); await flush()
 expect(node.textContent).toContain("Invalid installer package")
 expect(node.textContent).not.toContain("import its matching recovery key in Settings")
})
it("shows cancellation as a neutral notice and only requests cancellation once", async () => {
 let finish!: (value: boolean) => void
 state.wait = () => new Promise(resolve => {finish = resolve})
 const node = await mount()
 await act(async () => {node.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}))})
 await click(node,"Cancel operation")
 expect([...node.querySelectorAll("button")].find(button => button.textContent === "Cancelling…")?.disabled).toBe(true)
 await act(async () => finish(false)); await flush()
 expect(node.querySelector('[role="alert"]')).toBeNull()
 expect(node.textContent).toContain("Save cancelled. No installer was stored.")
 expect(api.cancel).toHaveBeenCalledTimes(1)
})

it("shows the Windows-only check without opening sign-in on other platforms", async () => {
 state.tab = "apps"; api.info.mockResolvedValueOnce({platform:"linux"})
 const node = await mount()
 await click(node,"Backup for Finance")
 const button = [...node.querySelectorAll("button")].find(button => button.textContent === "Check Windows enrollment")!
 expect(button.disabled).toBe(true)
 expect(node.textContent).toContain("Windows only.")
 await act(async () => button.click())
 expect(api.signIn).not.toHaveBeenCalled()
 expect(api.deviceStatus).not.toHaveBeenCalled()
})

it("keeps export failures beside the file and avoids unrelated key advice", async () => {
 const node = await mount()
 api.export.mockRejectedValueOnce(new Error("A file with that name already exists. Choose a new name."))
 await click(node,"Export original")
 const alert = node.querySelector('[role="alert"]')!
 expect(alert.closest("li")?.textContent).toContain("Finance.intunewin")
 expect(alert.textContent).toContain("Choose a new name")
 expect(alert.textContent).not.toContain("recovery key")
})
