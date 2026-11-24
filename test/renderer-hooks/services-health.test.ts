import { act, createElement, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ServicesSettings } from "../../src/renderer/components/ServicesSettings"
import { ServiceBackupNotice } from "../../src/renderer/components/ServiceBackupNotice"
import { healthDate, HEALTH_CAUSE_TEXT, READER_HEALTH_TEXT, SIGN_IN_HEALTH_TEXT, permissionRemediation } from "../../src/renderer/lib/connection-health-view"
import { healthFixture, healthScene, restoreGapFixture, HEALTH_TENANT, HEALTH_CLIENT } from "../fixtures/services-health"

const mocks = vi.hoisted(() => ({ check: vi.fn(), report: vi.fn(), acknowledge: vi.fn(), setEnabled: vi.fn(), setArea: vi.fn(), setAccess: vi.fn(), changed: null as null | ((tenantId: string) => void), tenants: [] as unknown[] }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => mocks.tenants }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { auth: { onAccountsChanged: (listener: (tenantId: string) => void) => { mocks.changed = listener; return () => { mocks.changed = null } } }, health: { check: mocks.check, report: mocks.report, acknowledge: mocks.acknowledge, onChanged: () => () => {} }, services: { setEnabled: mocks.setEnabled, setArea: mocks.setArea, setAccess: mocks.setAccess } } }))
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
  const cards = [...container.querySelectorAll('[data-service]')].filter(card => !card.parentElement?.closest('[data-service]'))
  expect(cards.map(card => card.querySelector("h3")?.textContent)).toEqual(["Defender", "Entra ID", "Intune"])
  expect(cards[1]?.querySelector('[data-service="conditionalAccess"] h3')?.textContent).toBe("Conditional Access")
  expect(container.textContent).not.toContain("no backup types for Entra ID yet")
  expect(container.querySelector('[data-area="externalIdentities"]')?.textContent).not.toContain("no backup types for this area yet")
  expect(container.querySelector('[data-area="externalIdentities"]')?.textContent).toContain("API connectors require the Backup Reader")
  expect(container.querySelector('[data-area="roles"]')?.textContent).not.toContain("no backup types for this area yet")
  expect(container.querySelector('[data-area="governance"]')?.textContent).not.toContain("no backup types for this area yet")
  expect(container.querySelector('[data-area="governance"]')?.textContent).toContain("Some features need Entra ID P2 or ID Governance")
  expect(container.textContent).toContain("These identify people and their group memberships")
  await toggle("Include Groups in backups")
  expect(mocks.setArea).toHaveBeenCalledWith(HEALTH_TENANT, "entra", "groups", true)
  await toggle("Include Conditional Access in backups")
  expect(mocks.setEnabled).toHaveBeenCalledWith(HEALTH_TENANT, HEALTH_CLIENT, "conditionalAccess", false, undefined)
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
  expect(mocks.setEnabled).toHaveBeenCalledExactlyOnceWith(HEALTH_TENANT, HEALTH_CLIENT, "intune", false, { confirmed: true })
})
it("saves the requested access without granting permissions", async () => {
  await render()
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Intune access to request"]')!
  await act(async () => { select.value = "backup"; select.dispatchEvent(new Event("change", { bubbles: true })) })
  expect(mocks.setAccess).toHaveBeenCalledWith(HEALTH_TENANT, "intune", "backup")
})
it("shows exactly the missing permissions alongside the in-app route", async () => {
  mocks.check.mockResolvedValue(healthScene("missing-permission"))
  await render()
  const routes = container.querySelector("[data-permission-routes]")!
  expect(routes.textContent).toContain("Azure CLI commands")
  expect(routes.textContent).toContain("Text for your administrator")
  const registration = routes.querySelector('a[href*="CallAnAPI"]')!.getAttribute("href")!
  expect(new URL(registration).pathname).toBe(`/${HEALTH_TENANT}`)
  expect(registration).toContain(`/appId/${HEALTH_CLIENT}/`)
  expect(routes.textContent).toContain("DeviceManagementConfiguration.ReadWrite.All")
  expect(routes.textContent).not.toContain("Policy.ReadWrite.ConditionalAccess")
  expect(routes.textContent).toContain("Add in the app")
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

it("distinguishes backup permission from restore-only gaps using real evaluator output", async () => {
  const report = restoreGapFixture()
  const intune = report.services.find(service => service.id === "intune")!
  expect(intune.permissions).toBe("present")
  expect(intune.areas.some(area => area.restore === "missing")).toBe(true)
  mocks.check.mockResolvedValue(report)
  await render()
  const card = container.querySelector('[data-service="intune"]')!
  expect(card.textContent).toContain("Backup: Permissions present. Restore: Permissions missing.")
  expect(card.textContent).toContain("Backup permissions are present. Restore needs: DeviceManagementConfiguration.ReadWrite.All.")
  expect(card.textContent).not.toContain("Backups work")
  expect(card.textContent).toContain("Not verified by a recent backup")
  const area = card.querySelector('[data-area="configuration"]')!
  expect(area.textContent).toContain("Backup permissions are present. Restore needs:")
  expect(card.textContent).toContain("The Backup and restore access level asks for these permissions. Choose Backup under Areas and access")
})

it.each(["notVerified", "partly"] as const)("names exactly what the %s backup could not read", async state => {
  const report = healthScene("cause-notRead")
  report.services[0]!.verified.state = state
  mocks.check.mockResolvedValue(report)
  await render()
  expect(container.textContent).toContain(`The backup on ${healthDate("2026-11-15T10:00:00Z")} with your sign-in could not read: ConfigurationPolicies.`)
  expect(container.textContent).not.toContain("Not verified by the last backup")
})

it("reloads on activation after the same tenant switches account and hides the previous verification while loading", async () => {
  await render()
  expect(container.textContent).toContain("with your sign-in")
  await render(createElement(ServicesSettings, { active: false }))
  let resolve!: (report: ReturnType<typeof healthFixture>) => void
  mocks.check.mockReturnValue(new Promise(done => { resolve = done }))
  await render(createElement(ServicesSettings, { active: true }))
  expect(mocks.check).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain("with your sign-in")
  const next = restoreGapFixture()
  await act(async () => resolve(next))
  expect(container.textContent).not.toContain("with your sign-in")
  expect(container.textContent).toContain("Not verified by a recent backup")
})

it("refreshes a changed account while active and drops the pending previous account answer", async () => {
  let resolve!: (report: ReturnType<typeof healthFixture>) => void
  mocks.check.mockReturnValue(new Promise(done => { resolve = done }))
  await render()
  const next = healthScene("graph-signInNeeded")
  next.services.forEach(service => { service.verified = { state: "noBackup", notVerified: [] }; service.areas.forEach(area => { area.verified = service.verified }) })
  mocks.check.mockResolvedValue(next)
  await act(async () => mocks.changed!(HEALTH_TENANT))
  await act(async () => resolve(healthFixture()))
  expect(mocks.check).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain("Sign-in needed")
  expect(container.textContent).not.toContain("Verified by the last backup")
})

it("reloads when the connected client ID changes within a tenant", async () => {
  await render()
  const next = { ...healthFixture(), clientId: "replacement" }
  mocks.tenants = [{ id: 1, name: "Contoso", credentials: { tenantId: HEALTH_TENANT, appId: "replacement" } }]
  mocks.check.mockResolvedValue(next)
  await render()
  expect(mocks.check).toHaveBeenCalledTimes(2)
})

const storageExpectations = {
  healthy: "Storage token acquired. This does not verify write access to your storage account. Run a backup to prove files can be written.",
  local: "Backups stay on this computer. No storage token is needed. A backup proves files can be written to the selected folder.",
  notChecked: "Storage token not checked yet.",
  unknown: "Microsoft refused the storage token check for an unknown reason.",
  signInNeeded: "Storage sign-in needed.",
  mfaRequired: "Microsoft requires MFA or another challenge for the storage token.",
  blockedByConditionalAccess: "Conditional Access blocked the storage token.",
  consentMissing: "Permission or admin consent for the storage token is missing.",
  registrationNotFoundInTenant: "App registration not found in this tenant during the storage token check.",
  registrationMisconfigured: "The app registration is not configured for the storage sign-in.",
  applicationDisabled: "The enterprise application is disabled for the storage sign-in.",
  servicePrincipalMissing: "The enterprise application is missing for the storage sign-in.",
  notAssigned: "Your account is not assigned to the storage sign-in application.",
  accountDisabled: "Your account is disabled for the storage sign-in.",
  accountLockedOrBlocked: "Your account is locked or Microsoft blocked the storage sign-in address.",
  wrongTenantOrAccount: "The tenant or account for the storage token does not match.",
  throttled: "Microsoft asked TenuVault to slow down the storage token check.",
  unreachable: "Microsoft did not answer the storage token check.",
}
it.each(Object.entries(storageExpectations))("explains storage %s independently of Graph read access", async (state, expected) => {
  mocks.check.mockResolvedValue(healthScene(`storage-${state}`))
  await render()
  const storage = [...container.querySelectorAll("h3")].find(h => h.textContent === "Backup storage")!.parentElement!
  expect(storage.textContent).toContain(expected)
  expect(storage.textContent).not.toContain("what can be read")
  if (!["healthy", "local"].includes(state)) expect(storage.querySelector('a[href="/portal/settings?section=storage"]')).not.toBeNull()
})

it("shows Defender coverage and opt-in directory area switches", async () => {
  mocks.check.mockResolvedValue(healthScene("defender-backup-types"))
  await render()
  const card = container.querySelector('[data-service="defender"]')!
  expect(card.textContent).toContain("17 Microsoft Graph configuration types")
  expect(card.textContent).toContain("Anti-phishing, Safe Links, Safe Attachments")
  expect(card.textContent).not.toContain("no backup types")
  const directory = container.querySelector('[data-service="entra"] [data-area="usersAndDevices"]')!
  expect(directory.querySelector('input[role="switch"]')).not.toBeNull()
})

it("keeps Defender on with a Needs access badge and the Start now repair link", async () => {
  const report = healthScene("defender-backup-types")
  mocks.check.mockResolvedValue({
    ...report,
    readOnly: true,
    coverage: [{ service: "defender", folders: ["DefenderCustomDetectionRules"], readable: [] }],
  })
  await render()
  const defender = container.querySelector('[data-service="defender"]')!
  expect(defender.textContent).toContain("Needs access")
  expect(defender.textContent).toContain("Defender needs more access.")
  expect(defender.textContent).toContain("Detection and response")
  expect(defender.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(true)
  expect(defender.querySelector("a")?.getAttribute("href")).toBe(`/portal/settings?section=signin#sign-in-${report.tenantId}`)
})

it("shows the plain status when the Backup Reader covers a service and notes when the sign-in lacks access", async () => {
  const report = healthScene("defender-backup-types")
  const folder = "DefenderSecureScoreControlStates"
  mocks.check.mockResolvedValue({
    ...report,
    readerReadableServices: ["defender", "intune"],
    coverage: [
      { service: "defender", folders: [folder], readable: [] },
      { service: "intune", folders: ["DeviceConfigurations"], readable: ["DeviceConfigurations"] },
    ],
  })
  await render()
  const defender = container.querySelector('[data-service="defender"]')!
  const intune = container.querySelector('[data-service="intune"]')!
  expect(defender.textContent).not.toContain("Needs access")
  expect(defender.textContent).toContain("Scheduled backups can read this service with the Backup Reader. Your sign-in can't read it.")
  expect(intune.textContent).not.toContain("Needs access")
  expect(intune.textContent).not.toContain("Your sign-in can't read it.")
})

it("clears Needs access from Settings after permissions are added and checked again", async () => {
  const report = healthScene("defender-backup-types")
  const folder = "DefenderSecureScoreControlStates"
  mocks.check.mockResolvedValue({ ...report, coverage: [{ service: "defender", folders: [folder], readable: [] }] })
  await render()
  const defender = container.querySelector('[data-service="defender"]')!
  expect(defender.textContent).toContain("Needs access")
  mocks.check.mockResolvedValue({ ...report, coverage: [{ service: "defender", folders: [folder], readable: [folder] }] })
  await click("Check again")
  expect(mocks.check).toHaveBeenLastCalledWith(HEALTH_TENANT, true)
  expect(defender.textContent).not.toContain("Needs access")
})

it("shows Start now as read-only and omits permission grant instructions", async () => {
  const report = restoreGapFixture()
  mocks.check.mockResolvedValue({ ...report, graph: { ...report.graph, state: "consentMissing" }, readOnly: true })
  await render()
  expect(container.textContent).toContain("Unavailable with Start now")
  expect(container.textContent).toContain("Start now is unavailable in this tenant")
  expect(container.textContent).not.toContain("grant consent")
  expect(container.textContent).not.toContain("Add the missing permissions")
  expect(container.textContent).not.toContain("Feature permissions")
  expect(container.querySelector('select[aria-label="Intune access to request"]')).toBeNull()
})
