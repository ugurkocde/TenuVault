import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({
  tenant: { id: 1, name: "Contoso", status: "healthy", credentials: { tenantId: "tenant", appId: "client" }, resources: { storageAccountName: "tvlocal-tenant" } },
}))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [mocks.tenant],
  useSelectedTenant: () => ({ selectedTenant: mocks.tenant, selectedTenantId: mocks.tenant.id, setSelectedTenantId: vi.fn() }),
  useTenantOperations: () => ({ updateTenant: vi.fn() }),
}))
vi.mock("@desktop/lib/bridge", () => ({ bridge: { license: { open: vi.fn() } } }))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => "pro" }))
vi.mock("@desktop/lib/backup-list", () => ({ useBackupList: () => ({ backups: [{
  id: "backup", timestamp: "2026-11-15T02:00:00Z", status: "Completed", totalPolicies: 2, counts: { DeviceConfigurations: 2 },
  scope: null, size: 2048, duration: 30,
}], loading: false, error: "", unresolved: 0, sealed: 0, damagedFiles: 0, damagedKinds: { counts: {} }, refresh: vi.fn() }) }))
vi.mock("@desktop/components/BackupSchedulePanel", () => ({ BackupSchedulePanel: () => null }))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("@desktop/components/ServiceBackupNotice", () => ({ ServiceBackupNotice: () => null }))
vi.mock("~/components/tenants/backup-progress-modal", () => ({ BackupProgressModal: () => null }))
vi.mock("~/components/backup/backup-changes-dialog", () => ({ BackupChangesDialog: () => null }))
import BackupRestorePage from "../../src/portal/app/portal/backup/page"

let root: Root
let container: HTMLDivElement
const paths = ["DeviceConfigurations/a.json", "DeviceConfigurations/b.json"]
const outcomes = [
  { path: paths[0], success: true, action: "created" },
  { path: paths[1], success: false, retryable: true, repairToken: "repair-b", error: "Try this policy again" },
]
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(entry => entry.textContent?.trim().startsWith(text))!
const click = async (text: string) => { await act(async () => button(text).click()) }
const filter = () => container.querySelector<HTMLSelectElement>("#backup-service")!
const changeFilter = async (value: string) => { await act(async () => { filter().value = value; filter().dispatchEvent(new Event("change", { bubbles: true })) }) }

beforeEach(() => { container = document.body.appendChild(document.createElement("div")); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function render() {
  const router = createMemoryRouter([{ path: "/portal/backup", element: createElement(BackupRestorePage) }], { initialEntries: ["/portal/backup?service=intune"] })
  await act(async () => root.render(createElement(RouterProvider, { router })))
  await click("Restore from this backup")
  await click("Select all")
  return router
}
function mockReads(restore: () => Promise<Response>) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (String(input) === "/api/list-backup-contents") return Response.json({ content: { groups: [
      { folder: "DeviceConfigurations", label: "configuration profile", area: "Devices", policies: paths.map((path, index) => ({ path, displayName: `Profile ${index}` })) },
      { folder: "Organization", label: "organization", area: "Tenant", policies: [{ path: "Organization/o.json" }] },
    ] } })
    if (String(input) === "/api/restore-preview") return Response.json({ items: body.paths.map((path: string) => ({ path, name: path.includes("Organization") ? "Organization" : `Profile ${paths.indexOf(path)}` })) })
    if (String(input) === "/api/restore-backup/progress") return Response.json({ total: 2, done: 1, current: paths[1], results: outcomes.slice(0, 1) })
    if (String(input) === "/api/restore-backup" && !body.approvalAction) return restore()
    return Response.json({})
  })
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}

it("keeps a deferred restore, progress and retry context through filter attempts and sidebar navigation", async () => {
  let finish!: (response: Response) => void
  const fetcher = mockReads(() => new Promise(resolve => { finish = resolve }))
  const router = await render()
  await click("Next")
  await click("Review")
  vi.useFakeTimers()
  await click("Restore 2 items")
  expect(filter().disabled).toBe(true)
  expect(container.querySelector("#backup-service-locked")?.textContent).toBe("Service cannot be changed while a restore is running.")
  await changeFilter("entra")
  expect(router.state.location.search).toBe("?service=intune&tab=restore")
  // Sidebar links change both the filter and the tab without leaving this page.
  await act(async () => { await router.navigate("/portal/backup?service=entra") })
  expect(filter().disabled).toBe(true)
  await act(async () => { await router.navigate("/portal/backup?service=entra&tab=restore"); await vi.advanceTimersByTimeAsync(700) })
  expect(container.textContent).toContain("Restoring Profile 1")
  expect(container.textContent).toContain("1 / 2")
  expect(container.textContent).toContain("This restore keeps the service and items chosen when it started.")
  expect([...container.querySelectorAll<HTMLButtonElement>('ol[aria-label="Restore steps"] button')].every(entry => entry.disabled)).toBe(true)
  const writes = () => fetcher.mock.calls.filter(([url, init]) => String(url) === "/api/restore-backup" && !JSON.parse(String(init?.body)).approvalAction)
  expect(writes()).toHaveLength(1)
  await act(async () => finish(Response.json({ success: false, details: { results: outcomes } })))
  expect(filter().disabled).toBe(false)
  await changeFilter("defender")
  expect(container.textContent).toContain("1 item completed; 1 failed.")
  expect(container.textContent).toContain("Profile 1")
  expect(container.textContent).toContain("Try this policy again")
  expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/list-backup-contents")).toHaveLength(1)
  await click("Retry failed items")
  expect(filter().disabled).toBe(true)
  expect(writes()).toHaveLength(2)
  expect(JSON.parse(String(writes()[1]![1]?.body)).selectedPolicies).toEqual([{ path: paths[1], repairToken: "repair-b" }])
  await act(async () => finish(Response.json({ success: true, details: { results: [{ path: paths[1], success: true, action: "created" }] } })))
  expect(container.textContent).toContain("2 items completed.")
  await click("Restore more items")
  expect(container.textContent).toContain("Service changed. Restore selections were cleared.")
  expect(button("Next").disabled).toBe(true)
})

it("clears selections with a visible note when the service changes before restoring", async () => {
  mockReads(async () => Response.json({}))
  await render()
  await click("Next")
  await click("Review")
  await changeFilter("entra")
  expect(container.textContent).toContain("Service changed. Restore selections were cleared. Choose items for this service.")
  expect(container.textContent).toContain("0 of 1 selected")
  expect(button("Next").disabled).toBe(true)
  expect(container.textContent).not.toContain("Profile 0")
})
