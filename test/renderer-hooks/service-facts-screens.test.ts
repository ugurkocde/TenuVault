import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ServiceModuleStatus, ServicesStatus } from "../../src/shared/ipc"
import { MODULE_BY_ID, MODULES, type ModuleId, type ServiceModule } from "../../src/shared/services/modules"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT = "11111111-1111-1111-1111-111111111111"
const state = vi.hoisted(() => ({ status: vi.fn(), setEnabled: vi.fn() }))

vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useTenants: () => [{ id: 1, name: "Contoso", credentials: { tenantId: "11111111-1111-1111-1111-111111111111", appId: "22222222-2222-2222-2222-222222222222" } }],
}))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { services: { status: state.status, setEnabled: state.setEnabled } } }))

import { BackupScopePicker } from "../../src/renderer/components/BackupScopePicker"
import { ServicesSettings } from "../../src/renderer/components/ServicesSettings"

const ORIGINAL = new Map(MODULES.map((module) => [module.id, { switchable: module.switchable, defaultOn: module.defaultOn, precheck: module.precheck }]))
const withFacts = (id: ModuleId, facts: Partial<Pick<ServiceModule, "switchable" | "defaultOn" | "precheck">>) => Object.assign(MODULE_BY_ID.get(id)!, facts)

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  state.status.mockReset()
  state.setEnabled.mockReset()
  for (const module of MODULES) Object.assign(module, ORIGINAL.get(module.id))
})

function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, element)))
  return container
}

const service = (id: ModuleId, overrides: Partial<ServiceModuleStatus>): ServiceModuleStatus => ({
  id, label: MODULE_BY_ID.get(id)!.label, description: "", switchable: true, enabled: true, roles: "", check: null, ...overrides,
})
const answer = (modules: ServiceModuleStatus[]): ServicesStatus => ({ tenantId: TENANT, checkedAt: null, modules })

describe("The Settings card reads switchable", () => {
  const switches = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>("button[role=switch]")]

  it("offers the switch for Intune and Conditional Access, now that Intune can be turned off", async () => {
    state.status.mockResolvedValue(answer([service("intune", {}), service("conditionalAccess", { enabled: false })]))
    const container = mount(createElement(ServicesSettings))
    await act(async () => undefined)
    expect(switches(container).map((button) => button.getAttribute("aria-checked"))).toEqual(["true", "false"])

    state.setEnabled.mockResolvedValue(answer([service("intune", { enabled: false }), service("conditionalAccess", { enabled: false })]))
    await act(async () => { switches(container)[0]!.click() })
    expect(state.setEnabled).toHaveBeenCalledWith(TENANT, "22222222-2222-2222-2222-222222222222", "intune", false)
    // A tenant with Intune off shows the service as off; the card neither fails nor claims a readiness.
    expect(switches(container).map((button) => button.getAttribute("aria-checked"))).toEqual(["false", "false"])
    expect(container.textContent).not.toContain("Backup: ")
    expect([...container.querySelectorAll("span")].filter((span) => span.textContent === "Off")).toHaveLength(2)
  })

  it("shows no switch for a service that cannot be switched, whatever else is true of it", async () => {
    state.status.mockResolvedValue(answer([service("intune", { switchable: false }), service("conditionalAccess", { enabled: false })]))
    const container = mount(createElement(ServicesSettings))
    await act(async () => undefined)
    expect(switches(container)).toHaveLength(1)
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
