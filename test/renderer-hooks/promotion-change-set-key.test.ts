import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const promotion = (id: string) => ({ id, title: `Promotion ${id}`, createdAt: "2026-10-01T00:00:00Z", items: [], summary: "", status: "in-review" })

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const selected = queryKey[2] as string | null | undefined
    if (queryKey.length === 2) return { data: { promotions: [promotion("a"), promotion("b")] }, refetch: vi.fn() }
    // Both details are cached, so switching shows the other one at once.
    return selected
      ? { data: { promotion: promotion(selected), changeSet: { id: `change-${selected}` }, rollbackChangeSet: { id: `rollback-${selected}` } }, refetch: vi.fn() }
      : { data: undefined, refetch: vi.fn() }
  },
}))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [] }))
vi.mock("../../src/renderer/features/promotion/PromotionPlanner", () => ({ PromotionPlanner: () => null }))
vi.mock("../../src/renderer/features/promotion/api", () => ({
  getPromotion: vi.fn(), listPromotions: vi.fn(), promotionActions: () => ({}), rollbackActions: () => ({}),
}))
// Shows the change set it was first mounted with, so kept state is visible.
vi.mock("../../src/renderer/features/shared/ChangeSetFlow", () => ({
  ChangeSetFlow: ({ changeSet }: { changeSet: { id: string } }) => {
    const [mounted] = useState(changeSet.id)
    return createElement("p", { "data-flow": "" }, mounted)
  },
}))

import PromotionTab from "../../src/renderer/features/promotion/PromotionTab"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
})

describe("Promotion change set review", () => {
  it("starts a fresh review when another promotion is selected", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const tenant = { id: 1, name: "Prod", credentials: { tenantId: "tenant" } } as unknown as Tenant
    act(() => root.render(createElement(PromotionTab, { tenant, plan: "msp", allowed: true })))
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")]
    const flows = () => [...container.querySelectorAll("[data-flow]")].map((node) => node.textContent)
    act(() => rows()[0]!.click())
    expect(flows()).toEqual(["change-a", "rollback-a"])
    act(() => rows()[1]!.click())
    expect(flows()).toEqual(["change-b", "rollback-b"])
  })
})
