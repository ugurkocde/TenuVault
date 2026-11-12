import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import { ErrorBoundary } from "../../src/renderer/components/ErrorBoundary"
import { desktopRouteBoundaryKey } from "../../src/renderer/lib/app-backup-route"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const tenant = "11111111-1111-1111-1111-111111111111"
const api = vi.hoisted(() => ({ info: vi.fn(async () => ({platform:"win32"})), accounts: vi.fn(), apps: vi.fn(), list: vi.fn(), attach: vi.fn(), export: vi.fn(), cancel: vi.fn(async () => {}), chooseStore: vi.fn(), signIn: vi.fn(), deviceStatus: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { app:{info:api.info}, auth: { accounts: api.accounts }, appSources: api } }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ selectedTenant: { name: "Contoso", credentials: { tenantId: tenant } } }) }))
import AppBackupPage from "../../src/renderer/pages/AppBackupPage"
window.scrollTo = vi.fn()
HTMLElement.prototype.scrollIntoView = vi.fn()
let root: Root | undefined
function Layout() {
  const { pathname } = useLocation()
  return createElement(ErrorBoundary, { key: desktopRouteBoundaryKey(pathname), children: createElement(Outlet) })
}
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.clearAllMocks() })
it.each(["save", "export"])("keeps an active %s running across the actual tab routes and caches the app list", async kind => {
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node)
  api.accounts.mockResolvedValue([{tenantId:tenant}])
  api.apps.mockResolvedValue({apps:[{id:tenant,name:"Finance",publisher:"Contoso"}],fetchedAt:"2026-11-12T00:00:00Z"})
  api.list.mockResolvedValue({storeName:"Installers",warnings:[],sources:[{id:"source",appName:"Finance",fileName:"Finance.intunewin",bytes:1024,createdAt:"2026-11-12T00:00:00Z",sha256:"abc"}]})
  let finish!: (value: boolean) => void
  api[kind === "save" ? "attach" : "export"].mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
  await act(async () => root!.render(createElement(MemoryRouter, {initialEntries:["/portal/app-backup"]}, createElement(Routes, null,
    createElement(Route, {element:createElement(Layout)}, createElement(Route, {path:"/portal/app-backup/:tabId?",element:createElement(AppBackupPage)}))))))
  const tab = async (label: string) => { await act(async () => [...node.querySelectorAll('nav[aria-label="App Backup sections"] a')].find(link => link.textContent === label)!.dispatchEvent(new MouseEvent("click", {bubbles:true,cancelable:true,button:0}))) }
  await tab("Saved installers")
  await act(async () => {
    if (kind === "save") node.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}))
    else [...node.querySelectorAll("button")].find(button => button.textContent?.trim() === "Export original")!.click()
  })
  expect(node.textContent).toContain(kind === "save" ? "Saving installer…" : "Exporting original…")
  await tab("Intune apps")
  expect(api.cancel).not.toHaveBeenCalled()
  expect(node.querySelector('nav a[aria-current="page"]')?.textContent).toBe("Intune apps")
  expect(node.textContent).toContain(kind === "save" ? "Saving installer…" : "Exporting original…")
  await tab("Saved installers")
  expect(api.cancel).not.toHaveBeenCalled()
  expect(api.apps).toHaveBeenCalledTimes(1)
  await act(async () => finish(true))
  expect(node.textContent).toContain(kind === "save" ? "Installer saved." : "Original package exported.")
  expect(api.cancel).not.toHaveBeenCalled()
})
