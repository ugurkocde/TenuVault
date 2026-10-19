import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  tenant: { id: 1, name: "Contoso", credentials: { tenantId: "tenant-a" } } as { id: number; name: string; credentials: { tenantId: string } },
  listSnapshots: vi.fn(async () => ({ snapshots: [{ id: "backup-of-a", usable: true, status: "Completed" }] })),
}))

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { baselines: [] }, refetch: vi.fn() }) }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ selectedTenant: state.tenant }) }))
vi.mock("../../src/renderer/lib/license", () => ({ useLicense: () => ({ status: {} }), useTenantPlan: () => "pro" }))
vi.mock("../../src/renderer/components/PlanGate", () => ({
  canUse: () => true,
  LockedPreview: () => null,
  GatedButton: ({ children, onClick }: { children: string; onClick: () => void }) => createElement("button", { type: "button", onClick }, children),
}))
vi.mock("../../src/renderer/features/custom-baselines/api", () => ({
  createFromSnapshot: vi.fn(), listCustomBaselines: vi.fn(), listSnapshots: state.listSnapshots,
}))

import BaselinesPage from "../../src/renderer/pages/BaselinesPage"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
})

describe("Company baseline from a backup", () => {
  it("forgets the backups of the previous tenant after a tenant switch", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const render = () => act(() => root.render(createElement(MemoryRouter, null, createElement(BaselinesPage))))
    render()
    const choose = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Choose a backup")
    await act(async () => { choose()!.click() })
    expect(container.textContent).toContain("backup-of-a")
    expect(choose()).toBeUndefined()

    state.tenant = { id: 2, name: "Fabrikam", credentials: { tenantId: "tenant-b" } }
    render()
    expect(container.textContent).not.toContain("backup-of-a")
    expect(choose()).toBeDefined()
  })
})
