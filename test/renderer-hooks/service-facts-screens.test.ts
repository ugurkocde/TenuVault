import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { ServiceBackupNotice } from "../../src/renderer/components/ServiceBackupNotice"
import { GRAPH_CLI_CLIENT_ID, TENUVAULT_CLIENT_ID } from "../../src/shared/tenant-connection"
import { healthFixture } from "../fixtures/services-health"
import { MODULE_BY_ID, MODULES, type ModuleId, type ServiceModule } from "../../src/shared/services/modules"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT = "11111111-1111-1111-1111-111111111111"
const state = vi.hoisted(() => ({ check: vi.fn(), report: vi.fn(), setEnabled: vi.fn() }))

vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useTenants: () => [{ id: 1, name: "Contoso", credentials: { tenantId: "11111111-1111-1111-1111-111111111111", appId: "22222222-2222-2222-2222-222222222222" } }],
}))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { health: { check: state.check, report: state.report, onChanged: () => () => undefined }, services: { setEnabled: state.setEnabled } } }))

import { BackupScopePicker } from "../../src/renderer/components/BackupScopePicker"
import { ServicesSettings } from "../../src/renderer/components/ServicesSettings"

const ORIGINAL = new Map(MODULES.map((module) => [module.id, { switchable: module.switchable, defaultOn: module.defaultOn, precheck: module.precheck }]))
const withFacts = (id: ModuleId, facts: Partial<Pick<ServiceModule, "switchable" | "defaultOn" | "precheck">>) => Object.assign(MODULE_BY_ID.get(id)!, facts)

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  state.check.mockReset()
  state.report.mockReset()
  state.setEnabled.mockReset()
  for (const module of MODULES) Object.assign(module, ORIGINAL.get(module.id))
})

function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(MemoryRouter, null, element))))
  return container
}

const answer = () => ({ ...healthFixture(), tenantId: TENANT, clientId: "22222222-2222-2222-2222-222222222222", acknowledgement: null })

describe("The Settings card reads switchable", () => {
  const serviceSwitch = (container: HTMLElement, label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Include ${label} in backups"]`)

  it("offers independent switches for Intune and Conditional Access", async () => {
    state.check.mockResolvedValue(answer())
    const container = mount(createElement(ServicesSettings))
    await act(async () => undefined)
    expect(serviceSwitch(container, "Intune")?.checked).toBe(true)
    expect(serviceSwitch(container, "Conditional Access")).not.toBeNull()
    const next = answer()
    next.services.find(service => service.id === "intune")!.enabled = false
    state.report.mockResolvedValue(next)
    await act(async () => { serviceSwitch(container, "Intune")!.click() })
    expect(state.setEnabled).toHaveBeenCalledWith(TENANT, "22222222-2222-2222-2222-222222222222", "intune", false, { confirmed: true })
    expect(serviceSwitch(container, "Intune")?.checked).toBe(false)
    expect(container.textContent).toContain("Off. New manual and scheduled backups leave out this service.")
  })

  it("shows Governance coverage and license limits in Settings", async () => {
    state.check.mockResolvedValue(answer())
    const container = mount(createElement(ServicesSettings))
    await act(async () => undefined)
    const governance = container.querySelector('[data-service="entra"] [data-area="governance"]')!
    expect(governance.textContent).toContain("Some features need Entra ID P2 or ID Governance")
    expect(governance.textContent).toContain("PDFs, review decisions and workflow history are excluded")
    expect(governance.textContent).not.toContain("no backup types")
  })

  it("shows no switch for a service that cannot be switched, whatever else is true of it", async () => {
    withFacts("intune", { switchable: false })
    state.check.mockResolvedValue(answer())
    const container = mount(createElement(ServicesSettings))
    await act(async () => undefined)
    expect(serviceSwitch(container, "Intune")).toBeNull()
    expect(serviceSwitch(container, "Conditional Access")).not.toBeNull()
    expect(container.textContent).toContain("Intune")
  })
})

describe("The scope picker follows the tenant's selection", () => {
  const picker = (services: Array<"intune" | "conditionalAccess" | "entra">) => mount(createElement(BackupScopePicker, { selection: { services }, value: { excluded: ["DeviceConfigurations"] }, onChange: () => undefined }))
  it("offers only the services that are on", () => {
    expect(picker(["intune"]).textContent).not.toContain("Entra ID: Authentication")
    expect(picker(["intune"]).textContent).not.toContain("Entra ID: Conditional Access")
    const text = picker(["entra"]).textContent ?? ""
    expect(text).toContain("Entra ID: Authentication")
    expect(text).not.toContain("Intune: Device configuration")
    expect(text).not.toContain("Entra ID: Groups")
    expect(text).toContain("All of 65 types")
    expect(text).toContain("Entra ID: Governance")
  })
  it("uses the explicit tenant choice even when the service defaults change", () => {
    withFacts("conditionalAccess", { defaultOn: true })
    withFacts("intune", { defaultOn: false })
    expect(picker(["intune"]).textContent).toContain("Intune: Device configuration")
    expect(picker(["intune"]).textContent).not.toContain("Entra ID: Conditional Access")
  })
})

describe("Tenant backup coverage", () => {
  it("shows license and setup guidance for Start now without a sign-in upgrade link", async () => {
    state.report.mockResolvedValue({
      ...answer(), clientId: GRAPH_CLI_CLIENT_ID,
      coverage: [{ service: "defender", folders: ["DefenderAttackSimulations"], readable: [], issues: { DefenderAttackSimulations: "license" } }],
    })
    const container = mount(createElement(ServiceBackupNotice, { tenantId: TENANT, showCoverage: true }))
    await act(async () => undefined)
    expect(container.textContent).toContain("Check the service license and setup in Microsoft 365.")
    expect(container.querySelector("a")).toBeNull()
  })

  it.each([
    ["22222222-2222-2222-2222-222222222222", "Add access", `/portal/settings?section=services&tenant=${TENANT}`],
    [TENUVAULT_CLIENT_ID, "Add access", `/portal/settings?section=signin&pack=conditionalAccess-backup#sign-in-${TENANT}`],
    [GRAPH_CLI_CLIENT_ID, "Add access", `/portal/settings?section=signin#sign-in-${TENANT}`],
  ])("shows each coverage state and the action for %s", async (clientId, label, href) => {
    state.report.mockResolvedValue({
      ...answer(), clientId,
      coverage: [
        { service: "intune", folders: ["Apps"], readable: [], issues: { Apps: "unknown" } },
        { service: "entra", folders: ["NamedLocations", "ConditionalAccessPolicies"], readable: [], issues: { NamedLocations: "role", ConditionalAccessPolicies: "permission" } },
        { service: "defender", folders: ["DefenderAttackSimulations"], readable: ["DefenderAttackSimulations"] },
      ],
    })
    const container = mount(createElement(ServiceBackupNotice, { tenantId: TENANT, showCoverage: true }))
    await act(async () => undefined)
    expect([...container.querySelectorAll("dt")].map(heading => heading.textContent)).toEqual(["Defender", "Entra ID", "Intune"])
    expect(container.querySelector('[aria-label="Defender backup coverage"]')?.textContent).toBe("Defender1 of 1 readable")
    expect(container.textContent).toContain("Permission not granted")
    expect(container.textContent).toContain("Your role can't do this")
    expect(container.textContent).toContain("Coverage unknown for 1.")
    expect([...container.querySelectorAll("a")].find(link => link.textContent === label)?.getAttribute("href")).toBe(href)
  })
})
