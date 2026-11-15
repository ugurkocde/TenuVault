import { act, createElement, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ServicesSettings } from "../../src/renderer/components/ServicesSettings"
import { ServiceBackupNotice } from "../../src/renderer/components/ServiceBackupNotice"
import { healthDate, HEALTH_CAUSE_TEXT, READER_HEALTH_TEXT, SIGN_IN_HEALTH_TEXT, permissionRemediation } from "../../src/renderer/lib/connection-health-view"
import { healthFixture, healthScene, HEALTH_TENANT, HEALTH_CLIENT } from "../fixtures/services-health"

const mocks = vi.hoisted(() => ({ check: vi.fn(), report: vi.fn(), acknowledge: vi.fn(), setEnabled: vi.fn(), setArea: vi.fn(), setAccess: vi.fn(), tenants: [] as unknown[] }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => mocks.tenants }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { health: { check: mocks.check, report: mocks.report, acknowledge: mocks.acknowledge, onChanged: () => () => {} }, services: { setEnabled: mocks.setEnabled, setArea: mocks.setArea, setAccess: mocks.setAccess } } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let client: QueryClient
const tenant = (id: string, name: string) => ({ id, name, credentials: { tenantId: id, appId: HEALTH_CLIENT } })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.tenants = [tenant(HEALTH_TENANT, "Contoso")]
  mocks.check.mockResolvedValue(healthFixture())
  mocks.report.mockResolvedValue(healthFixture())
  mocks.acknowledge.mockResolvedValue(healthFixture())
  mocks.setEnabled.mockResolvedValue({})
  mocks.setArea.mockResolvedValue(healthFixture())
  mocks.setAccess.mockResolvedValue(healthFixture())
  container = document.body.appendChild(document.createElement("div"))
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  vi.stubGlobal("cancelAnimationFrame", clearTimeout)
})
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); vi.unstubAllGlobals() })
async function render(element: ReactElement = createElement(ServicesSettings)) {
  await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, element))) })
}
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(button => button.textContent === text)
  expect(button, text).toBeDefined()
  await act(async () => { button!.click() })
}
async function toggle(label: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  expect(input).not.toBeNull()
  await act(async () => input!.click())
}

it("shows the first check running without claiming permissions or acknowledging anything", async () => {
  mocks.check.mockReturnValue(new Promise(() => undefined))
  await render()
  expect(container.textContent).toContain("Checking connection health")
  expect(container.textContent).not.toContain("Permissions present")
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Check again")?.disabled).toBe(true)
  expect(mocks.acknowledge).not.toHaveBeenCalled()
})

for (const [state, text] of Object.entries(SIGN_IN_HEALTH_TEXT)) {
  it(`shows the Graph ${state} state and its next step`, async () => {
    mocks.check.mockResolvedValue(healthScene(`graph-${state}`))
    await render()
    expect(container.textContent).toContain(text)
    expect(mocks.check).toHaveBeenCalledWith(HEALTH_TENANT)
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Check again")).toBe(true)
    if (!["healthy", "local"].includes(state)) expect(container.querySelector('a[href="/portal/settings?section=signin"]')).not.toBeNull()
  })
  it(`shows the storage ${state} state separately`, async () => {
    mocks.check.mockResolvedValue(healthScene(`storage-${state}`))
    await render()
    expect(container.textContent).toContain(text)
    if (!["healthy", "local"].includes(state)) expect(container.querySelector('a[href="/portal/settings?section=storage"]')).not.toBeNull()
  })
}
for (const [state, text] of Object.entries(READER_HEALTH_TEXT)) {
  it(`shows the Backup Reader ${state} state and settings action`, async () => {
    mocks.check.mockResolvedValue(healthScene(`reader-${state}`))
    await render()
    expect(container.textContent).toContain(text)
    expect(container.querySelector('a[href="/portal/settings?section=background"]')).not.toBeNull()
  })
}
for (const [cause, text] of Object.entries(HEALTH_CAUSE_TEXT)) {
  it(`explains the ${cause} cause without inventing another diagnosis`, async () => {
    mocks.check.mockResolvedValue(healthScene(`cause-${cause}`))
    await render()
    expect(container.textContent).toContain(text)
  })
}
it("keeps an admin's verification visible alongside the Backup Reader's loss", async () => {
  mocks.check.mockResolvedValue(healthScene("reader-lost-access"))
  await render()
  expect(container.textContent).toContain(`Verified by the last backup on ${healthDate("2026-11-15T10:00:00Z")} with your sign-in`)
  expect(container.textContent).toContain("Scheduled backups with the Backup Reader cannot read ConfigurationPolicies")
})
it("shows all services, Conditional Access separately and the personal data statement before opting in", async () => {
  mocks.check.mockResolvedValue(healthScene("personal-data"))
  await render()
  expect(container.querySelector('[data-service="defender"]')).not.toBeNull()
  expect(container.textContent).toContain("no backup types for Entra ID yet")
  expect(container.textContent).toContain("These identify people and their group memberships")
  await toggle("Include Groups in backups")
  expect(mocks.setArea).toHaveBeenCalledWith(HEALTH_TENANT, "entra", "groups", true)
  await toggle("Include Entra Conditional Access in backups")
  expect(mocks.setEnabled).toHaveBeenCalledWith(HEALTH_TENANT, HEALTH_CLIENT, "conditionalAccess", false)
})
it("does not turn Intune off before confirmation and leaves it on after Cancel", async () => {
  await render()
  await toggle("Include Intune in backups")
  expect(document.body.textContent).toContain("scheduled backups will stop backing up Intune")
  expect(mocks.setEnabled).not.toHaveBeenCalled()
  await click("Cancel")
  expect(mocks.setEnabled).not.toHaveBeenCalled()
  await toggle("Include Intune in backups")
  await click("Turn off Intune")
  expect(mocks.setEnabled).toHaveBeenCalledExactlyOnceWith(HEALTH_TENANT, HEALTH_CLIENT, "intune", false)
})
it("saves the requested access without granting permissions", async () => {
  await render()
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Intune access to request"]')!
  await act(async () => { select.value = "backup"; select.dispatchEvent(new Event("change", { bubbles: true })) })
  expect(mocks.setAccess).toHaveBeenCalledWith(HEALTH_TENANT, "intune", "backup")
})
it("shows exactly the missing permissions in all three routes and leaves the in-app route unimplemented", async () => {
  mocks.check.mockResolvedValue(healthScene("missing-permission"))
  await render()
  const routes = container.querySelector("[data-permission-routes]")!
  expect(routes.textContent).toContain("Azure CLI commands")
  expect(routes.textContent).toContain("Text for your administrator")
  expect(routes.querySelector('a[href*="CallAnAPI"]')?.getAttribute("href")).toContain(HEALTH_CLIENT)
  expect(routes.textContent).toContain("DeviceManagementConfiguration.ReadWrite.All")
  expect(routes.textContent).not.toContain("Policy.ReadWrite.ConditionalAccess")
  expect(routes.textContent).toContain("Add in the app: not available yet")
})
it("names a replaced registration and its missing permissions", async () => {
  mocks.check.mockResolvedValue(healthScene("registration-replaced"))
  await render()
  expect(container.textContent).toContain("App registration replaced")
  expect(container.textContent).toContain("The replacement lacks: DeviceManagementConfiguration.ReadWrite.All")
})
it("acknowledges the displayed receipt only once after rendering dated changes", async () => {
  const report = healthScene("changes")
  mocks.check.mockResolvedValue(report)
  mocks.acknowledge.mockImplementation(async (_tenant, receipt) => {
    expect(receipt).toBe(report.acknowledgement)
    expect(container.textContent).toContain(`Found under an earlier sign-in on ${healthDate("2026-11-13T10:00:00Z")}`)
    return { ...report, changes: [] }
  })
  await render()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(mocks.acknowledge).toHaveBeenCalledExactlyOnceWith(HEALTH_TENANT, report.acknowledgement)
  expect(container.textContent).toContain(`Added since ${healthDate("2026-11-12T10:00:00Z")}`)
  await click("Check again")
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(mocks.check).toHaveBeenLastCalledWith(HEALTH_TENANT, true)
  expect(mocks.acknowledge).toHaveBeenCalledTimes(1)
})
it("never acknowledges a report while the Settings section is hidden", async () => {
  mocks.check.mockResolvedValue(healthScene("changes"))
  await render(createElement(ServicesSettings, { active: false }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(mocks.acknowledge).not.toHaveBeenCalled()
  await render(createElement(ServicesSettings, { active: true }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(mocks.acknowledge).toHaveBeenCalledExactlyOnceWith(HEALTH_TENANT, "fixture-receipt")
})

it.each([false, true])("drops a late answer or error after selecting another tenant (error: %s)", async fail => {
  let resolve!: (value: ReturnType<typeof healthFixture>) => void
  let reject!: (error: Error) => void
  mocks.tenants.push(tenant("other", "Fabrikam"))
  mocks.check.mockImplementation((id: string) => id === HEALTH_TENANT ? new Promise((yes, no) => { resolve = yes; reject = no }) : Promise.resolve({ ...healthFixture(), tenantId: "other" }))
  await render()
  const select = container.querySelector<HTMLSelectElement>("select")!
  await act(async () => { select.value = "other"; select.dispatchEvent(new Event("change", { bubbles: true })) })
  await act(async () => { if (fail) reject(new Error("Old tenant failure")); else resolve(healthScene("changes")) })
  expect(container.textContent).toContain("Fabrikam")
  expect(container.textContent).not.toContain("Added since")
  expect(container.textContent).not.toContain("Old tenant failure")
  expect(mocks.acknowledge).not.toHaveBeenCalled()
})
it("shows a failed check and allows retry", async () => {
  mocks.check.mockRejectedValueOnce(new Error("No answer"))
  await render()
  expect(container.textContent).toContain("No answer")
  await click("Check again")
  expect(container.textContent).toContain("Permissions present")
})
it("explains Intune off where backups and schedules are listed", async () => {
  mocks.report.mockResolvedValue(healthScene("intune-off"))
  await render(createElement(ServiceBackupNotice, { tenantId: HEALTH_TENANT }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(container.textContent).toContain("Intune is off")
  expect(container.textContent).toContain("New manual and scheduled backups leave out Intune")
})
it("generates commands for only manifest gaps, with no duplicate or unknown permission", () => {
  const fix = permissionRemediation(healthFixture(), ["Policy.Read.All", "Policy.Read.All", "Not.A.Permission"])
  expect(fix.names).toEqual(["Policy.Read.All"])
  expect(fix.commands).toContain("oauth2PermissionScopes[?value=='Policy.Read.All']")
  expect(fix.commands).not.toContain("Not.A.Permission")
  expect(fix.request).toContain(HEALTH_TENANT)
})
