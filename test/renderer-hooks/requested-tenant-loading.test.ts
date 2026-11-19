import { act, createElement, Profiler } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import { TenantProvider, useSelectedTenant, type Tenant } from "../../src/portal/contexts/TenantContext"
import { serializeTenants } from "../../src/portal/lib/tenant-state"
import { IntunePageGuard } from "../../src/renderer/components/IntunePageGuard"

const state = vi.hoisted(() => ({ status: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { services: { status: state.status }, health: { onChanged: () => () => {} } } }))
vi.mock("../../src/renderer/lib/license", async original => ({ ...await original<typeof import("../../src/renderer/lib/license")>(), useLicense: () => ({ status: null }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; sessionStorage.clear(); vi.clearAllMocks() })

const tenant = { id: 1, name: "Contoso", credentials: { tenantId: "one", appId: "client", clientSecret: "" } } as Tenant

function Workflow() {
  const { selectedTenant } = useSelectedTenant()
  return createElement("p", null, `App Backup for ${selectedTenant?.name}`)
}

it.each([null, "1", "2"])("waits for persisted tenants on the first commit of an App Backup link with selected tenant %s", async selected => {
  sessionStorage.setItem("tenuvault_tenants", serializeTenants([tenant, { ...tenant, id: 2, name: "Fabrikam", credentials: { ...tenant.credentials!, tenantId: "two" } }]))
  if (selected) sessionStorage.setItem("tenuvault_selected_tenant", selected)
  state.status.mockImplementation(async (tenantId: string) => ({ tenantId, modules: [{ id: "intune", enabled: true }] }))
  const container = document.createElement("div")
  root = createRoot(container)
  const commits: string[] = []
  await act(async () => root!.render(createElement(Profiler, { id: "tenant-link", onRender: () => commits.push(container.textContent ?? "") },
    createElement(TenantProvider, null, createElement(MemoryRouter, { initialEntries: ["/portal/app-backup?tenant=one"] },
      createElement(IntunePageGuard, null, createElement(Workflow)),
    )),
  )))
  expect(commits[0]).toBe("Loading connected tenants...")
  expect(commits.every(commit => !commit.includes("The linked tenant is not connected"))).toBe(true)
  expect(commits.every(commit => !commit.includes("App Backup for Fabrikam"))).toBe(true)
  expect(state.status.mock.calls.map(call => call[0])).toEqual(["one"])
  expect(container.textContent).toBe("App Backup for Contoso")
})

it("decides that a tenant is missing only after the real provider loads an empty list", async () => {
  sessionStorage.setItem("tenuvault_tenants", "[]")
  const container = document.createElement("div")
  root = createRoot(container)
  const commits: string[] = []
  await act(async () => root!.render(createElement(Profiler, { id: "tenant-link", onRender: () => commits.push(container.textContent ?? "") },
    createElement(TenantProvider, null, createElement(MemoryRouter, { initialEntries: ["/portal/app-backup?tenant=one"] },
      createElement(IntunePageGuard, null, createElement(Workflow)),
    )),
  )))
  expect(commits[0]).toBe("Loading connected tenants...")
  expect(container.textContent).toContain("The linked tenant is not connected")
  expect(state.status).not.toHaveBeenCalled()
})
