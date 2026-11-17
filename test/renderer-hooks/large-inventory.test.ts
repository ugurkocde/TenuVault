import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { LargeComparison, LargeContents } from "../../src/portal/components/backup/large-inventory"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement
const credentials = { tenantId: "tenant", storageAccountName: "store", appId: "client", clientSecret: "placeholder" }
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals() })
async function render(element: ReturnType<typeof createElement>) {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container)
  await act(async () => { root!.render(element) })
}
it("renders and replaces bounded comparison windows in dark mode at 1024 pixels", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 }); document.documentElement.classList.add("dark")
  const calls: any[] = []
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body)
    return Response.json({ changes: [{ id: body.cursor[0] ? "second" : "first", change: "modified" }], examined: 1000, unchanged: 999, next: body.cursor[0] ? null : [1000, 1000] })
  }))
  await render(createElement(LargeComparison, { credentials, backupId: "new", baseline: "old", folders: ["DeviceConfigurations"] }))
  expect(container.textContent).toContain("first: modified")
  await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Next page")!.click() })
  expect(container.textContent).toContain("second: modified")
  expect(container.textContent).not.toContain("first: modified")
  expect(calls[1].cursor).toEqual([1000, 1000])
  expect(container.querySelector(".bg-blue-50")).not.toBeNull()
  document.documentElement.classList.remove("dark")
})
it("drops stale results after a tenant switch", async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal("fetch", vi.fn((_url, init) => JSON.parse(init.body).tenantId === "tenant" ? new Promise(resolve => { finish = resolve }) : Promise.resolve(Response.json({ changes: [{ id: "current", change: "added" }], examined: 1, unchanged: 0, next: null }))))
  await render(createElement(LargeComparison, { credentials, backupId: "new", baseline: "old", folders: ["DeviceConfigurations"] }))
  await act(async () => { root!.render(createElement(LargeComparison, { credentials: { ...credentials, tenantId: "other" }, backupId: "new", baseline: "old", folders: ["DeviceConfigurations"] })) })
  await act(async () => { finish(Response.json({ changes: [{ id: "stale", change: "removed" }], examined: 1, unchanged: 0, next: null })) })
  expect(container.textContent).toContain("current: added")
  expect(container.textContent).not.toContain("stale")
})
it("pages backup contents without accumulating prior rows", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const page = JSON.parse(init.body).largePage
    return Response.json({ hasMore: page === 0, content: { metadata: { LargeItems: { DeviceConfigurations: {} } }, groups: [{ folder: "DeviceConfigurations", label: "Inventory", count: 100_000, policies: [{ path: `p${page}`, displayName: `object${page}` }] }] } })
  }))
  await render(createElement(LargeContents, { credentials, backupId: "backup" }))
  expect(container.textContent).toContain("100,000 objects")
  await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Next page")!.click() })
  expect(container.textContent).toContain("object1")
  expect(container.textContent).not.toContain("object0")
})

it("filters large inventory groups by service without changing the paging request", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ hasMore: false, content: { metadata: { LargeItems: { Groups: {}, DeviceConfigurations: {} } }, groups: [
    { folder: "Groups", label: "Groups", count: 1, policies: [{ path: "g", displayName: "Directory group" }] },
    { folder: "DeviceConfigurations", label: "Profiles", count: 1, policies: [{ path: "p", displayName: "Intune profile" }] },
  ] } })))
  await render(createElement(LargeContents, { credentials, backupId: "backup", service: "entra" }))
  expect(container.textContent).toContain("Directory group")
  expect(container.textContent).not.toContain("Intune profile")
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).not.toHaveProperty("service")
})
