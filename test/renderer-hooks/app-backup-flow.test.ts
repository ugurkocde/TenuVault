import { MemoryRouter } from "react-router-dom"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { it, expect, vi, afterEach } from "vitest"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const api = vi.hoisted(() => ({ accounts: vi.fn(async () => [{tenantId:"tenant"}]), details:vi.fn(),apps: vi.fn(), signIn: vi.fn(async () => {}), openExternal: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { auth: {accounts:api.accounts}, appSources: api, app: { openExternal: api.openExternal } } }))
import { IntuneAppsView } from "../../src/renderer/features/app-backup/IntuneAppsView"
HTMLElement.prototype.scrollIntoView = vi.fn()
let root: Root
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.clearAllMocks() })
it("starts from the actual app list and explains preparation without enabling capture or changing assignments", async () => {
  api.apps.mockResolvedValue({ apps: [{ id: "11111111-1111-1111-1111-111111111111", name: "Finance", publisher: "Contoso" }], fetchedAt: new Date().toISOString() })
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node)
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(IntuneAppsView, { tenant: "tenant", busy: false, attach: vi.fn(), devicePanel: createElement("div", null, "Check this PC") }))))
  expect(node.textContent).toContain("Finance")
  const button = [...node.querySelectorAll("button")].find(b => b.textContent?.startsWith("Backup"))!
  await act(async () => button.click())
  expect(node.textContent).toContain("Required can install the app automatically")
  expect(node.textContent).toContain("Installed program files are not a substitute")
  const future = node.querySelector("details")!
  expect(future.open).toBe(false)
  expect(future.closest("tr")?.previousElementSibling?.textContent).toContain("Finance")
  expect(future.textContent).toContain("Changing assignments will not enable capture")
  expect(node.querySelector("section[aria-label^='Backup'] button")?.textContent).toBe("Close")
  expect([...node.querySelectorAll("button")].find(b => b.textContent === "Choose installer file")).toBeTruthy()
  expect(api.signIn).not.toHaveBeenCalled()
  const close = [...node.querySelectorAll("button")].find(b => b.textContent === "Close")!
  close.focus()
  await act(async () => close.click())
  expect(document.activeElement).toBe(button)
  expect(node.textContent).not.toContain("Back up Finance")
})

it("opens signed out without an error or inventory request, with an offline save link", async () => {
  api.accounts.mockResolvedValueOnce([])
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node)
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(IntuneAppsView, { tenant: "tenant", busy: false, attach: vi.fn(), devicePanel: null }))))
  expect(api.apps).not.toHaveBeenCalled()
  expect(node.querySelector("input")?.disabled).toBe(true)
  expect(node.querySelector('[role="alert"]')).toBeNull()
  expect(node.textContent).toContain("Saved installers still works offline")
  expect([...node.querySelectorAll("a")].some(a => a.textContent === "Save an existing installer" && a.getAttribute("href") === "/portal/app-backup/versions")).toBe(true)
})

it("loads the connected admin's apps without asking them to sign in again", async () => {
 api.apps.mockResolvedValueOnce({apps:[{id:"app",name:"Finance",publisher:"Contoso",version:"4.2"}],fetchedAt:new Date().toISOString()})
 const node=document.createElement("div");document.body.append(node);root=createRoot(node)
 await act(async()=>root.render(createElement(MemoryRouter,null,createElement(IntuneAppsView,{tenant:"tenant",busy:false,attach:vi.fn(),devicePanel:null}))))
 expect(node.querySelector("table")?.textContent).toContain("4.2")
 expect([...node.querySelectorAll("button")].some(button=>button.textContent?.includes("Reconnect Microsoft"))).toBe(false)
 expect(api.signIn).not.toHaveBeenCalled()
})

it("closes a details portal when the cached apps view becomes inactive", async () => {
 api.apps.mockResolvedValue({apps:[{id:"app",name:"Finance",publisher:"Contoso"}],fetchedAt:new Date().toISOString()})
 api.details.mockImplementationOnce(()=>new Promise(()=>{}))
 const node=document.createElement("div");document.body.append(node);root=createRoot(node)
 const props={tenant:"tenant",busy:false,attach:vi.fn(),devicePanel:null}
 await act(async()=>root.render(createElement(MemoryRouter,null,createElement(IntuneAppsView,{...props,active:true}))))
 const button=[...node.querySelectorAll("button")].find(button=>button.textContent?.trim()==="Details for Finance")!
 await act(async()=>button.click())
 expect(document.querySelector('[role="dialog"]')).not.toBeNull()
 await act(async()=>root.render(createElement(MemoryRouter,null,createElement(IntuneAppsView,{...props,active:false}))))
 expect(document.querySelector('[role="dialog"]')).toBeNull()
 await act(async()=>root.render(createElement(MemoryRouter,null,createElement(IntuneAppsView,{...props,active:true}))))
 expect(document.querySelector('[role="dialog"]')).toBeNull()
})
