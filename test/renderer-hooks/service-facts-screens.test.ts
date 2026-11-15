import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
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
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { health: { check: state.check, report: state.report }, services: { setEnabled: state.setEnabled } } }))

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
    expect(serviceSwitch(container, "Entra Conditional Access")).not.toBeNull()
    const next = answer()
    next.services.find(service => service.id === "intune")!.enabled = false
    state.report.mockResolvedValue(next)
    await act(async () => { serviceSwitch(container, "Intune")!.click() })
    expect(state.setEnabled).toHaveBeenCalledWith(TENANT, "22222222-2222-2222-2222-222222222222", "intune", false, { confirmed: true })
    expect(serviceSwitch(container, "Intune")?.checked).toBe(false)
    expect(container.textContent).toContain("Off. New manual and scheduled backups leave out this service.")
  })

  it("shows no switch for a service that cannot be switched, whatever else is true of it", async () => {
    withFacts("intune", { switchable: false })
    state.check.mockResolvedValue(answer())
    const container = mount(createElement(ServicesSettings))
    await act(async () => undefined)
    expect(serviceSwitch(container, "Intune")).toBeNull()
    expect(serviceSwitch(container, "Entra Conditional Access")).not.toBeNull()
    expect(container.textContent).toContain("Intune")
  })
})

describe("The scope picker reads defaultOn", () => {
  const note = (label: string) => `Backed up only when ${label} is turned on for the tenant in Settings, under Services and permissions.`
  const picker = () => mount(createElement(BackupScopePicker, { value: { excluded: ["DeviceConfigurations"] }, onChange: () => undefined }))

  it("says a service that starts off needs turning on, and says nothing for Intune", () => {
    const text = picker().textContent ?? ""
    expect(text.split(note("Entra Conditional Access"))).toHaveLength(2)
    expect(text).not.toContain(note("Intune"))
  })

  it("follows the fact when it changes, and not the other two", () => {
    withFacts("conditionalAccess", { switchable: false, precheck: false })
    withFacts("intune", { switchable: false, precheck: true })
    expect(picker().textContent).toContain(note("Entra Conditional Access"))
    expect(picker().textContent).not.toContain(note("Intune"))

    withFacts("conditionalAccess", { defaultOn: true })
    withFacts("intune", { defaultOn: false })
    const text = picker().textContent ?? ""
    expect(text).not.toContain(note("Entra Conditional Access"))
    // Every Intune area carries the note once Intune would start off.
    expect(text.split(note("Intune")).length - 1).toBe(9)
  })
})
