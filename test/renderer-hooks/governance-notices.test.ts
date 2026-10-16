import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "~/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const baseline = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: {} }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }))
vi.mock("~/hooks/dashboard/useBaselineScore", () => ({ useBaselineScore: () => baseline.current }))

import { COMPLIANCE_SCORING_NOTICE, COMPLIANCE_SCORING_NOTICE_KEY, ComplianceScoringNotice } from "../../src/renderer/components/ComplianceScoringNotice"
import { BaselineScoreTile } from "../../src/portal/app/portal/dashboard/page"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  localStorage.clear()
})

function mount(changed: boolean): HTMLDivElement {
  const container = document.createElement("div")
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(ComplianceScoringNotice, { changed })))
  return container
}

describe("compliance scoring notice", () => {
  it("shows once on the first page that needs it, not on every page after", () => {
    expect(mount(false).textContent).toBe("")
    expect(localStorage.getItem(COMPLIANCE_SCORING_NOTICE_KEY)).toBeNull()
    const first = mount(true)
    expect(first.textContent).toContain(COMPLIANCE_SCORING_NOTICE)
    expect(localStorage.getItem(COMPLIANCE_SCORING_NOTICE_KEY)).toBe("true")
    // It stays where it appeared, but the next framework page or scores tab does not repeat it.
    expect(first.textContent).toContain(COMPLIANCE_SCORING_NOTICE)
    expect(mount(true).textContent).toBe("")
  })
})

describe("dashboard baseline score tile", () => {
  const tenant = { id: "t", name: "Contoso", credentials: { tenantId: "11111111-1111-1111-1111-111111111111", appId: "app" } } as unknown as Tenant

  it("shows saved results scored under older rules as such, not as missing", () => {
    baseline.current = { enabled: true, isLoading: false, error: null, latest: null, assessed: 0, unavailable: 0, historyOnly: { frameworkName: "ISO/IEC 27001:2022", message: "Scored under older rules. Compare again to score. An app update changed how capabilities are counted." } }
    const html = renderToStaticMarkup(createElement(BaselineScoreTile, { tenant, plan: "pro" }))
    expect(html).toContain("No current score")
    expect(html).toContain("ISO/IEC 27001:2022: Scored under older rules. Compare again to score.")
    expect(html).not.toContain("No saved framework comparison")
  })

  it("names the framework and formats score and coverage the same way", () => {
    baseline.current = { enabled: true, isLoading: false, error: null, assessed: 1, unavailable: 0, historyOnly: null, latest: { latest: {
      identity: { frameworkName: "ISO/IEC 27001:2022" }, freshness: { assessedAt: "2026-10-16T10:00:00Z", stale: false }, incompleteCollection: [],
      score: { score: 9.6, coverage: 96.3, counts: { unknown: 2 }, reason: null },
    } } }
    const html = renderToStaticMarkup(createElement(BaselineScoreTile, { tenant, plan: "pro" }))
    expect(html).toContain("Baseline score: ISO/IEC 27001:2022")
    expect(html).toContain("9.6%")
    expect(html).toContain("On 96.3% coverage, 2 unknown.")
  })
})
