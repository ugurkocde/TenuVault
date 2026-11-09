import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { expect, it, vi } from "vitest"
import HealthReviewTab from "../../src/renderer/features/health-review/HealthReviewTab"
import type { Tenant } from "~/contexts/TenantContext"

vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: {} }))
vi.mock("../../src/renderer/features/health-review/api", async (original) => ({
  ...await original<object>(),
  healthApi: { status: async () => ({ schedule: { enabled: true }, readiness: { state: "not-licensed", message: "Needs Pro" }, lastRun: null, counts: { critical: 0, high: 0, medium: 0, low: 0 } }), findings: async () => [] },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it("announces a configured review paused on Community", async () => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(HealthReviewTab, { tenant: { name: "Contoso", credentials: { tenantId: "contoso" } } as Tenant, plan: "community", allowed: false }))))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(container.textContent).toContain("Paused on Community")
    expect(container.querySelector('a[href="/license"]')).not.toBeNull()
  } finally { act(() => root.unmount()); container.remove(); client.clear() }
})
