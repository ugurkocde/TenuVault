import { act, createElement, createContext, useContext, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ tenant: { id: 1, name: "Contoso", credentials: { tenantId: "one", appId: "client" } }, tenants: [] as { id: number; name: string; credentials: { tenantId: string; appId: string } }[], select: (_id: number | null) => {}, status: vi.fn(), workflowMounted: vi.fn(), workflowUnmounted: vi.fn(), unsubscribe: vi.fn(), changed: null as null | ((id: string) => void) }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => { const id = useContext(SelectionContext); return { selectedTenant: state.tenants.find(tenant => tenant.id === id) ?? state.tenant, setSelectedTenantId: state.select } }, useTenants: () => state.tenants, useTenantsLoaded: () => true }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { services: { status: state.status }, health: { onChanged: (listener: typeof state.changed) => { state.changed = listener; return () => { state.unsubscribe(); state.changed = null } } } } }))
vi.mock("../../src/renderer/lib/license", () => ({ useTenantPlan: () => "pro", useLicense: () => ({ status: {} }) }))
vi.mock("../../src/renderer/features/scores/ScoresTab", () => ({ default: ({ tenant }: { tenant: { name: string } }) => { state.workflowMounted(); return createElement("p", null, `Scores for ${tenant.name}`) } }))
vi.mock("../../src/renderer/features/governance/DeviationsTab", () => ({ default: () => createElement("p", null, "Deviation register") }))
vi.mock("../../src/renderer/features/standards/CustomizationsTab", () => ({ default: () => createElement("p", null, "Customization register") }))
import HubPage from "../../src/renderer/pages/HubPage"
import { IntunePageGuard } from "../../src/renderer/components/IntunePageGuard"

it("never mounts an Intune page while off and drops a late answer from the earlier tenant", async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  const root = createRoot(container)
  let answer!: (value: unknown) => void
  state.status.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  const render = () => root.render(createElement(MemoryRouter, null, createElement(IntunePageGuard, null, createElement("p", null, "Intune workflow"))))
  await act(async () => render())
  expect(container.textContent).not.toContain("Intune workflow")
  state.tenant = { id: 2, name: "Fabrikam", credentials: { tenantId: "two", appId: "client" } }
  state.status.mockResolvedValue({ tenantId: "two", modules: [{ id: "intune", enabled: false }] })
  await act(async () => render())
  expect(container.textContent).toContain("This page needs Intune")
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/portal/settings?section=services")
  await act(async () => answer({ tenantId: "one", modules: [{ id: "intune", enabled: true }] }))
  expect(container.textContent).not.toContain("Intune workflow")
  state.status.mockResolvedValue({ tenantId: "two", modules: [{ id: "intune", enabled: true }] })
  await act(async () => state.changed?.("two"))
  expect(container.textContent).toContain("Intune workflow")
  act(() => root.unmount())
})

const SelectionContext = createContext(0)
const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  state.tenants = []
  vi.clearAllMocks()
})

function TenantHost({ children }: { children: React.ReactNode }) {
  const [id, setId] = useState(1)
  state.tenant = state.tenants.find(tenant => tenant.id === id)!
  state.select = setId as typeof state.select
  return createElement(SelectionContext.Provider, { value: id }, children)
}

function FrameworkJob() {
  state.workflowMounted()
  useEffect(() => () => { state.workflowUnmounted() }, [])
  const [params] = useSearchParams()
  return createElement("p", null, `Framework job ${params.get("job")} for ${state.tenant.name}`)
}

async function openLink(route: string, removedTenantId?: string) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  state.tenants = [
    { id: 1, name: "Contoso", credentials: { tenantId: "one", appId: "client" } },
    { id: 2, name: "Fabrikam", credentials: { tenantId: "two", appId: "client" } },
  ]
  state.tenants = state.tenants.filter(tenant => tenant.credentials.tenantId !== removedTenantId)
  const container = document.createElement("div")
  const root = createRoot(container)
  roots.push(root)
  const rerender = () => root.render(createElement(MemoryRouter, { initialEntries: [route] },
    createElement(TenantHost, { children: createElement(Routes, null,
      createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(IntunePageGuard, { children: createElement(FrameworkJob) }) }),
      createElement(Route, { path: "/portal/governance/:tabId", element: createElement(HubPage, { hubId: "governance" }) }),
    ) }),
  ))
  await act(async () => rerender())
  return { container, rerender }
}

it.each([true, false])("checks the destination tenant for a CIS job link before mounting its workflow (Intune %s)", async enabled => {
  state.status.mockImplementation(async (tenantId: string) => ({ tenantId, modules: [{ id: "intune", enabled: tenantId === "two" ? enabled : !enabled }] }))
  const { container } = await openLink("/portal/frameworks/cis-intune?tenant=TWO&job=saved-job")
  expect(state.status.mock.calls.map(call => call[0])).toEqual(["two"])
  if (enabled) expect(container.textContent).toContain("Framework job saved-job for Fabrikam")
  else {
    expect(container.textContent).toContain("Intune is off for Fabrikam")
    expect(container.textContent).not.toContain("Framework job")
  }
})

it("resolves a hub tenant link and keeps Governance navigation usable while Intune is off", async () => {
  state.status.mockImplementation(async (tenantId: string) => ({ tenantId, modules: [{ id: "intune", enabled: false }] }))
  const { container } = await openLink("/portal/governance/scores?tenant=TWO")
  expect(state.status.mock.calls.map(call => call[0])).toEqual(["two"])
  expect(container.textContent).toContain("Intune is off for Fabrikam")
  expect(container.querySelector('nav[aria-label="Governance sections"]')).not.toBeNull()
  const click = async (text: string) => act(async () => { [...container.querySelectorAll('a')].find(link => link.textContent?.includes(text))!.click() })
  await click("Accepted deviations")
  expect(container.textContent).toContain("Deviation register")
  expect(container.textContent).not.toContain("This page needs Intune")
  await click("Customizations")
  expect(container.textContent).toContain("Customization register")
})

it("opens the requested hub tenant when Intune is enabled there", async () => {
  state.status.mockImplementation(async (tenantId: string) => ({ tenantId, modules: [{ id: "intune", enabled: tenantId === "two" }] }))
  const { container } = await openLink("/portal/governance/scores?tenant=TWO")
  expect(container.textContent).toContain("Scores for Fabrikam")
  expect(container.textContent).not.toContain("This page needs Intune")
})

it.each([
  ["unknown", "unknown-tenant", undefined],
  ["removed", "two", "two"],
])("does not mount any workflow for a tenant link that is %s", async (_label, tenantId, removedTenantId) => {
  state.status.mockImplementation(async (id: string) => ({ tenantId: id, modules: [{ id: "intune", enabled: true }] }))
  for (const route of ["/portal/frameworks/cis-intune", "/portal/governance/scores"]) {
    const { container } = await openLink(`${route}?tenant=${tenantId}&job=saved-job`, removedTenantId)
    expect(state.workflowMounted).not.toHaveBeenCalled()
    expect(state.status).not.toHaveBeenCalled()
    expect(container.textContent).toContain("The linked tenant is not connected")
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/portal/tenants")
  }
})

it("unmounts the linked workflow and shows the notice when its tenant is removed while open", async () => {
  state.status.mockImplementation(async (tenantId: string) => ({ tenantId, modules: [{ id: "intune", enabled: true }] }))
  const { container, rerender } = await openLink("/portal/frameworks/cis-intune?tenant=two&job=saved-job")
  expect(container.textContent).toContain("Framework job saved-job for Fabrikam")
  expect(state.workflowUnmounted).not.toHaveBeenCalled()
  const mounted = state.workflowMounted.mock.calls.length
  await act(async () => {
    state.tenants = state.tenants.filter(tenant => tenant.credentials.tenantId !== "two")
    rerender()
  })
  expect(state.workflowUnmounted).toHaveBeenCalledOnce()
  expect(state.unsubscribe).toHaveBeenCalledOnce()
  expect(container.textContent).not.toContain("Framework job")
  expect(container.textContent).toContain("The linked tenant is not connected")
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/portal/tenants")
  await act(async () => state.changed?.("two"))
  expect(state.workflowMounted).toHaveBeenCalledTimes(mounted)
  expect(container.textContent).toContain("The linked tenant is not connected")
})
