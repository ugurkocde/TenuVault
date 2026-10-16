import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "~/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT = "11111111-1111-1111-1111-111111111111"
const failing = vi.hoisted(() => ({ summary: vi.fn(), detail: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: {} }))
vi.mock("../../src/renderer/lib/internal-cis", () => ({ useInternalCisBenchmarks: () => false }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [] }))
vi.mock("../../src/renderer/lib/license", () => ({ useLicense: () => ({ status: null }), tenantLicense: () => undefined, tenantPlan: () => null }))
vi.mock("../../src/renderer/features/scores/api", async (original) => ({ ...(await original<object>()), loadSummary: failing.summary, loadDetail: failing.detail }))

import ScoresTab from "../../src/renderer/features/scores/ScoresTab"
import { ScoreDetail } from "../../src/renderer/features/scores/ScoreDetail"
import { FindingsList } from "../../src/renderer/features/health-review/FindingsList"

const tenant = { id: "t", name: "Contoso", credentials: { tenantId: TENANT, appId: "app" } } as unknown as Tenant
const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  localStorage.clear()
})

/** A client holding an older successful read, so the mounted query refetches and that refetch fails. */
function clientWithCache(key: unknown[], data: unknown): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  client.setQueryData(key, data, { updatedAt: Date.now() - 60_000 })
  return client
}

async function render(client: QueryClient, element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, element))) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

const cachedScore = {
  frameworkId: "iso-27001", frameworkName: "ISO", state: "scored", message: null, trend: [], incompatible: [], historyOnly: [],
  latest: {
    identity: { runId: "r", frameworkId: "iso-27001", frameworkName: "Cached ISO card", frameworkVersion: "2022", rulesetVersion: "m", rulesetSha256: "", snapshotSha256: "", profile: "Default", platforms: ["windows"], assessedAt: "2026-10-01T00:00:00Z" },
    versionDetail: null, unit: "capability", uncheckedReferences: 0, freshness: { assessedAt: "2026-10-01T00:00:00Z", ageDays: 1, stale: false },
    score: { counts: { matching: 1, different: 0, missing: 1, unknown: 0, outsideScope: 0 }, evaluated: 2, assessed: 2, score: 50, coverage: 100, state: "scored", reason: null },
    incompleteCollection: [], gapCount: 1, topGaps: [],
  },
}

describe("a failed refresh never shows old results as current", () => {
  it("hides cached scores and disables the export behind the error with Retry", async () => {
    failing.summary.mockRejectedValue(new Error("Scores could not be read (500)."))
    const client = clientWithCache(["scores-summary", TENANT], { tenantId: TENANT, tenantName: "Contoso", formula: "F", staleAfterDays: 30, scoringChanged: false, frameworks: [cachedScore] })
    const view = await render(client, createElement(ScoresTab, { tenant, plan: "pro", allowed: true }))
    expect(failing.summary).toHaveBeenCalled()
    expect(view.textContent).toContain("Scores could not be read (500).")
    expect(view.textContent).toContain("Retry")
    expect(view.textContent).not.toContain("Cached ISO card")
    const exports = [...view.querySelectorAll("button")].filter((button) => /Export (CSV|JSON)/.test(button.textContent ?? ""))
    expect(exports.length).toBe(2)
    expect(exports.every((button) => button.disabled)).toBe(true)
  })

  it("hides cached score evidence in the detail behind the error with Retry", async () => {
    failing.detail.mockRejectedValue(new Error("The comparison could not be read (502)."))
    const client = clientWithCache(["scores-detail", TENANT, "iso-27001"], { tenantId: TENANT, tenantName: "Contoso", detail: { identity: { ...cachedScore.latest.identity, frameworkName: "Cached detail" }, versionDetail: null, unit: "capability", freshness: cachedScore.latest.freshness, score: cachedScore.latest.score, incompleteCollection: [], items: [], gaps: [], controls: [], unassessedNote: null } })
    const view = await render(client, createElement(ScoreDetail, { tenant, frameworkId: "iso-27001", onClose: () => undefined }))
    expect(view.textContent).toContain("The comparison could not be read (502).")
    expect(view.textContent).toContain("Retry")
    expect(view.textContent).not.toContain("Cached detail")
  })
})

describe("health review findings load state", () => {
  const list = (load: { status: "pending" | "error" | "success"; error: unknown }) => createElement(FindingsList, { tenant, findings: [], lastRun: { id: "r", status: "completed", summary: "", trigger: "manual", startedAt: "", finishedAt: "2026-10-15T08:00:00Z", missedWindows: 0, checks: [], counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, deliveries: [] }, load, onChanged: () => undefined })

  it("shows the error with Retry, not the clean empty state, when the findings read fails", async () => {
    const view = await render(new QueryClient(), list({ status: "error", error: new Error("Findings could not be read.") }))
    expect(view.textContent).toContain("Findings could not be read.")
    expect(view.textContent).toContain("Retry")
    expect(view.textContent).not.toContain("No open findings")
  })

  it("shows loading until the findings are read, and the empty state only after a successful read", async () => {
    expect((await render(new QueryClient(), list({ status: "pending", error: null }))).textContent).toContain("Loading findings")
    expect((await render(new QueryClient(), list({ status: "pending", error: null }))).textContent).not.toContain("No open findings")
    expect((await render(new QueryClient(), list({ status: "success", error: null }))).textContent).toContain("No open findings in the latest review")
  })
})
