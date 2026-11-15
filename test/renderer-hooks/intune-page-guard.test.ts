import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ tenant: { name: "Contoso", credentials: { tenantId: "one", appId: "client" } }, status: vi.fn(), changed: null as null | ((id: string) => void) }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ selectedTenant: state.tenant }) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { services: { status: state.status }, health: { onChanged: (listener: typeof state.changed) => { state.changed = listener; return () => {} } } } }))
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
  state.tenant = { name: "Fabrikam", credentials: { tenantId: "two", appId: "client" } }
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
