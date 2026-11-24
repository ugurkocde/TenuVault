import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, MemoryRouter, Outlet, RouterProvider } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ServicesStatus } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({
  tenant: { id: 1, name: "Contoso", status: "healthy", credentials: { tenantId: "tenant-1", appId: "client" }, resources: { storageAccountName: "tvlocal-tenant-1" } },
  status: vi.fn(), changed: undefined as ((tenantId: string) => void) | undefined,
}))
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [mocks.tenant],
  useSelectedTenant: () => ({ selectedTenant: mocks.tenant, selectedTenantId: mocks.tenant.id, setSelectedTenantId: vi.fn() }),
  useTenantOperations: () => ({ updateTenant: vi.fn() }),
}))
vi.mock("@desktop/lib/bridge", () => ({ bridge: {
  services: { status: mocks.status }, health: { onChanged: (listener: typeof mocks.changed) => { mocks.changed = listener; return () => { mocks.changed = undefined } } },
  license: { open: vi.fn() }, backups: {},
} }))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => "pro" }))
vi.mock("@desktop/lib/backup-list", () => ({ useBackupList: () => ({ backups: [{
  id: "backup", timestamp: "2026-11-15T02:00:00Z", status: "Completed", totalPolicies: 10, counts: { DeviceConfigurations: 2, ConditionalAccessPolicies: 3, Organization: 4, DefenderSecureScoreControlStates: 1 },
  scope: { excluded: [], description: "Everything" }, size: 2048, duration: 30,
}], loading: false, error: "", unresolved: 0, sealed: 0, damagedFiles: 0, damagedKinds: { counts: {} }, refresh: vi.fn() }) }))
vi.mock("@desktop/components/BackupSchedulePanel", () => ({ BackupSchedulePanel: () => null }))
vi.mock("@desktop/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("@desktop/components/ServiceBackupNotice", () => ({ ServiceBackupNotice: () => null }))
vi.mock("~/components/tenants/backup-progress-modal", () => ({ BackupProgressModal: () => null }))
vi.mock("~/components/backup/backup-changes-dialog", () => ({ BackupChangesDialog: () => null }))
vi.mock("~/components/backup/restore-wizard", () => ({ RestoreWizard: () => null }))
import { ServicesNavigation } from "../../src/renderer/components/ServicesNavigation"
import BackupRestorePage from "../../src/portal/app/portal/backup/page"
import { matchesBackupService } from "../../src/renderer/lib/backup-service"

let root: Root
let container: HTMLDivElement
function status(tenantId = "tenant-1", off: string[] = []): ServicesStatus {
  return { tenantId, checkedAt: null, modules: ["intune", "entra", "defender"].map(id => ({ id, enabled: !off.includes(id) })) } as ServicesStatus
}
beforeEach(() => {
  mocks.tenant = { ...mocks.tenant, id: 1, credentials: { tenantId: "tenant-1", appId: "client" } }
  mocks.status.mockReset().mockResolvedValue(status())
  container = document.body.appendChild(document.createElement("div"))
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const sidebar = () => createElement(ServicesNavigation, { linkClass: (active: boolean) => active ? "active" : "inactive" })
function Frame() { return createElement("div", null, sidebar(), createElement(Outlet)) }
async function render(url = "/portal/backup", content: ReactNode = null) {
  const router = createMemoryRouter([{ element: createElement(Frame), children: [{ path: "/portal/backup", element: content }, { path: "/portal/settings", element: createElement("p", null, "Services and permissions") }] }], { initialEntries: [url] })
  await act(async () => root.render(createElement(RouterProvider, { router })))
  return router
}
const links = () => [...container.querySelectorAll<HTMLAnchorElement>('section[aria-label="Services"] a')]
const active = () => links().find(link => link.getAttribute("aria-current") === "page")?.textContent
const navigate = async (router: Awaited<ReturnType<typeof render>>, to: string | number) => { await act(async () => { if (typeof to === "number") await router.navigate(to); else await router.navigate(to) }) }

it("renders three service links and follows URL selection, clearing, reload and history", async () => {
  const router = await render("/portal/backup?service=entra")
  expect(links().map(link => link.textContent)).toEqual(["Defender", "Entra ID", "Intune"])
  expect(links().map(link => link.getAttribute("href"))).toEqual(["/portal/backup?service=defender", "/portal/backup?service=entra", "/portal/backup?service=intune"])
  expect(active()).toBe("Entra ID")
  await navigate(router, "/portal/backup?service=defender")
  expect(active()).toBe("Defender")
  await navigate(router, -1)
  expect(active()).toBe("Entra ID")
  await navigate(router, "/portal/backup")
  expect(active()).toBeUndefined()
  await navigate(router, "/portal/backup?service=unknown")
  expect(active()).toBeUndefined()
})

it("opens Entra ID from the sidebar when Conditional Access is the only Entra ID area enabled", async () => {
  const base = status("tenant-1", ["entra"])
  mocks.status.mockResolvedValue({ ...base, modules: [...base.modules, { ...base.modules[0]!, id: "conditionalAccess", enabled: true }] })
  await render("/portal/backup?service=entra", createElement(BackupRestorePage))
  expect(links().map(link => link.textContent)).toEqual(["Defender", "Entra ID", "Intune"])
  expect(active()).toBe("Entra ID")
  expect(container.querySelector('section[aria-label="Entra ID"]')?.textContent).toContain("Conditional Access")
})

it("keeps an off service visible with a muted badge and opens the Settings card", async () => {
  mocks.status.mockResolvedValue(status("tenant-1", ["defender"]))
  const router = await render("/portal/backup?service=defender")
  const link = links()[0]!
  expect(link.textContent).toBe("DefenderOff")
  expect(link.querySelector(".bg-secondary")?.textContent).toBe("Off")
  expect(active()).toBeUndefined()
  expect(link.getAttribute("href")).toBe("/portal/settings?section=services")
  await act(async () => link.click())
  expect(router.state.location.search).toBe("?section=services")
  expect(container.textContent).toContain("Services and permissions")
})

it("links an enabled service that needs access to its tenant's Services card and clears the badge after repair", async () => {
  mocks.status.mockResolvedValueOnce({ ...status(), needsAccess: ["defender"] })
  const router = await render("/portal/backup?service=defender")
  const link = links()[0]!
  expect(link.textContent).toBe("DefenderNeeds access")
  expect(active()).toBeUndefined()
  await act(async () => link.click())
  expect(router.state.location.search).toBe("?section=services&tenant=tenant-1")
  expect(router.state.location.hash).toBe("#service-defender")
  await act(async () => mocks.changed!("tenant-1"))
  expect(links()[0]!.textContent).toBe("Defender")
})

it("keeps each service name intact beside its Needs access badge", async () => {
  mocks.status.mockResolvedValue({ ...status(), needsAccess: ["defender", "entra", "intune"] })
  await render()
  expect(links().map(link => link.firstElementChild?.nextElementSibling?.textContent)).toEqual(["Defender", "Entra ID", "Intune"])
  for (const link of links()) {
    expect(link.querySelector("span")?.classList.contains("shrink-0")).toBe(true)
    expect(link.querySelector("span")?.classList.contains("truncate")).toBe(false)
  }
})

it.each([true, false])("opens backup contents while pending, then follows an explicit enabled=%s result", async enabled => {
  let finish!: (result: ServicesStatus) => void
  mocks.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const router = await render()
  const link = links()[1]!
  expect(link.textContent).toBe("Entra ID")
  expect(link.title).toBe("View Entra ID backup contents")
  await act(async () => link.click())
  expect(router.state.location.pathname).toBe("/portal/backup")
  expect(router.state.location.search).toBe("?service=entra")
  await act(async () => finish(status("tenant-1", enabled ? [] : ["entra"])))
  expect(links()[1]!.textContent).toBe(enabled ? "Entra ID" : "Entra IDOff")
  expect(links()[1]!.getAttribute("href")).toBe(enabled ? "/portal/backup?service=entra" : "/portal/settings?section=services")
  expect(active()).toBe(enabled ? "Entra ID" : undefined)
})

it.each([true, false])("keeps failed status distinct from Off, then recovers to enabled=%s", async enabled => {
  mocks.status.mockRejectedValueOnce(new Error("Status unavailable"))
  const router = await render()
  expect(links().map(link => link.textContent)).toEqual(["Defender", "Entra ID", "Intune"])
  expect(links().every(link => link.getAttribute("href")?.startsWith("/portal/backup?service="))).toBe(true)
  await act(async () => links()[1]!.click())
  expect(router.state.location.pathname).toBe("/portal/backup")
  expect(router.state.location.search).toBe("?service=entra")
  mocks.status.mockResolvedValue(status("tenant-1", enabled ? [] : ["entra"]))
  await act(async () => mocks.changed!("tenant-1"))
  await act(async () => links()[1]!.click())
  expect(router.state.location.pathname).toBe(enabled ? "/portal/backup" : "/portal/settings")
  expect(router.state.location.search).toBe(enabled ? "?service=entra" : "?section=services")
  expect(links()[1]!.textContent).toBe(enabled ? "Entra ID" : "Entra IDOff")
})

it("refreshes service switches and drops late status results from the previous tenant and request", async () => {
  let finish!: (result: ServicesStatus) => void
  mocks.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await act(async () => root.render(createElement(MemoryRouter, null, sidebar())))
  mocks.tenant = { ...mocks.tenant, id: 2, credentials: { tenantId: "tenant-2", appId: "other-client" } }
  mocks.status.mockResolvedValue(status("tenant-2", ["defender"]))
  await act(async () => root.render(createElement(MemoryRouter, null, sidebar())))
  await act(async () => finish(status()))
  expect(links()[0]!.textContent).toBe("DefenderOff")
  expect(mocks.status).toHaveBeenLastCalledWith("tenant-2", "other-client")
  mocks.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  act(() => mocks.changed!("tenant-2"))
  mocks.status.mockResolvedValue(status("tenant-2"))
  await act(async () => mocks.changed!("tenant-2"))
  await act(async () => finish(status("tenant-2", ["intune"])))
  expect(links().map(link => link.textContent)).toEqual(["Defender", "Entra ID", "Intune"])
  const calls = mocks.status.mock.calls.length
  act(() => mocks.changed!("tenant-1"))
  expect(mocks.status).toHaveBeenCalledTimes(calls)
})

it("narrows page contents and trends by service and restores All for an unknown URL value", async () => {
  const router = await render("/portal/backup?service=entra", createElement(BackupRestorePage))
  const contents = () => [...container.querySelectorAll("h3")].find(h => h.textContent === "Contents")!.parentElement!.textContent
  const trends = () => [...container.querySelectorAll("h2")].find(h => h.textContent === "Trends by policy type")!.parentElement!.textContent
  expect(contents()).toContain("Conditional Access")
  expect(contents()).toContain("Organization")
  expect(contents()).not.toContain("Device configuration")
  expect(trends()).not.toContain("Device configuration")
  const select = container.querySelector<HTMLSelectElement>("#backup-service")!
  expect([...select.options].map(option => option.textContent)).toEqual(["All", "Defender", "Entra ID", "Intune"])
  expect(select.value).toBe("entra")
  await act(async () => { select.value = "intune"; select.dispatchEvent(new Event("change", { bubbles: true })) })
  expect(router.state.location.search).toBe("?service=intune")
  expect(contents()).not.toContain("Conditional Access")
  expect(contents()).toContain("Device configuration")
  expect(active()).toBe("Intune")
  await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Schedule")!.click() })
  expect(router.state.location.search).toBe("?service=intune&tab=schedule")
  expect(active()).toBe("Intune")
  await navigate(router, -1)
  await act(async () => { select.value = "defender"; select.dispatchEvent(new Event("change", { bubbles: true })) })
  expect(contents()).toContain("Secure Score control states")
  expect(contents()).not.toContain("Device configuration")
  expect(trends()).not.toContain("Organization")
  expect(active()).toBe("Defender")
  await act(async () => { select.value = "all"; select.dispatchEvent(new Event("change", { bubbles: true })) })
  expect(router.state.location.search).toBe("")
  expect(active()).toBeUndefined()
  await navigate(router, "/portal/backup?service=nonsense")
  expect(select.value).toBe("all")
  expect(contents()).toContain("Conditional Access")
  expect(contents()).toContain("Device configuration")
  expect(matchesBackupService("unknown-folder", "entra")).toBe(false)
  expect(matchesBackupService("unknown-folder", "all")).toBe(true)
})
