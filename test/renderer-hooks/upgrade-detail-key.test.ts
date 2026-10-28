import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const upgrade = (id: string) => ({ id, title: `Upgrade ${id}`, summary: "", status: "review" })

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey.length === 2) return { data: { installs: [], upgrades: [upgrade("a"), upgrade("b")] }, refetch: vi.fn() }
    if (queryKey[2] === "sources") return { data: { runs: [] }, refetch: vi.fn() }
    // Both details are cached, so switching shows the other one at once.
    const selected = queryKey[2] as string | null
    return selected
      ? { data: { upgrade: upgrade(selected), comparison: {}, changeSets: [] }, refetch: vi.fn() }
      : { data: undefined, refetch: vi.fn() }
  },
}))
vi.mock("../../src/renderer/features/baseline-upgrades/api", () => ({
  baselineSources: vi.fn(), checkReleases: vi.fn(), compareRelease: vi.fn(), getUpgrade: vi.fn(), listBaselines: vi.fn(), recordInstall: vi.fn(),
}))
// Shows the upgrade it was first mounted with, standing in for its unsaved conflict choices.
vi.mock("../../src/renderer/features/baseline-upgrades/UpgradeDetail", () => ({
  UpgradeDetail: ({ upgrade }: { upgrade: { id: string } }) => {
    const [mounted] = useState(upgrade.id)
    return createElement("p", { "data-detail": "" }, mounted)
  },
}))

import BaselineUpgradesTab from "../../src/renderer/features/baseline-upgrades/BaselineUpgradesTab"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
})

describe("Baseline upgrade detail", () => {
  it("drops unsaved choices when another upgrade is selected", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const tenant = { id: 1, name: "Contoso", credentials: { tenantId: "tenant" } } as unknown as Tenant
    act(() => root.render(createElement(BaselineUpgradesTab, { tenant, plan: "msp", allowed: true })))
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")]
    const detail = () => container.querySelector("[data-detail]")?.textContent
    act(() => rows()[0]!.click())
    expect(detail()).toBe("a")
    act(() => rows()[1]!.click())
    expect(detail()).toBe("b")
  })
})
