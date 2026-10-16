import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import type { Tenant } from "~/contexts/TenantContext"
import { checkSignals } from "../src/main/features/health-review/rules"
import { FindingsList, emptyFindingsText } from "../src/renderer/features/health-review/FindingsList"
import type { Finding, Run } from "../src/renderer/features/health-review/api"
import { formatPercent, formatScore, groupUnavailable, namesLabel } from "../src/renderer/features/scores/api"
import { invalidateScores, invalidateScoresOnComparison, SCORE_QUERY_KEYS } from "../src/renderer/features/scores/invalidate"
import type { FrameworkJob } from "../src/renderer/lib/framework-jobs"
import { deviationLabel } from "../src/renderer/features/standards/state"
import { TENANT_A } from "./feature-helpers"

vi.mock("../src/renderer/lib/bridge", () => ({ bridge: {} }))

const tenant = { id: "t", name: "Contoso", credentials: { tenantId: TENANT_A, appId: "app" } } as unknown as Tenant

describe("score formatting", () => {
  it("formats every percent the same way and shows the score with its coverage", () => {
    expect(formatPercent(72.5)).toBe("72.5%")
    expect(formatPercent(9.6)).toBe("9.6%")
    expect(formatPercent(100)).toBe("100%")
    expect(formatPercent(null)).toBe("Not scored")
    expect(formatScore({ score: 9.6, coverage: 96 })).toBe("9.6% on 96% coverage")
    expect(formatScore({ score: 50, coverage: null })).toBe("50%, coverage unknown")
    expect(formatScore({ score: null, coverage: 0 })).toBe("Not scored")
  })

  it("collapses frameworks that failed for the same reason into one message", () => {
    const failed = Array.from({ length: 18 }, (_, index) => ({ frameworkName: `Framework ${index}`, message: "Saved comparisons could not be read (500)." }))
    const groups = groupUnavailable([...failed, { frameworkName: "ISO 27001", message: "Denied" }])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.names).toHaveLength(18)
    expect(namesLabel(groups[0]!.names)).toBe("18 frameworks")
    expect(namesLabel(groups[1]!.names)).toBe("ISO 27001")
  })
})

describe("score invalidation", () => {
  function seeded() {
    const client = new QueryClient()
    for (const key of SCORE_QUERY_KEYS) client.setQueryData([...key, TENANT_A], { cached: true })
    client.setQueryData(["health-status", TENANT_A], { cached: true })
    return client
  }
  const invalidated = (client: QueryClient, key: readonly unknown[]) => client.getQueryState([...key, TENANT_A])?.isInvalidated

  it("invalidates the scores, an open detail and the dashboard tile when a comparison completes", () => {
    const client = seeded()
    let emit: ((job: FrameworkJob) => void) | null = null
    const unsubscribe = invalidateScoresOnComparison(client, (listener) => {
      emit = listener
      return () => { emit = null }
    })
    emit!({ status: "failed" } as FrameworkJob)
    expect(SCORE_QUERY_KEYS.some((key) => invalidated(client, key))).toBe(false)
    emit!({ status: "completed" } as FrameworkJob)
    for (const key of SCORE_QUERY_KEYS) expect(invalidated(client, key)).toBe(true)
    expect(client.getQueryState(["health-status", TENANT_A])?.isInvalidated).toBe(false)
    unsubscribe()
    expect(emit).toBeNull()
  })

  it("covers every score query, whatever its stale time", () => {
    expect(SCORE_QUERY_KEYS.map((key) => key[0])).toEqual(["scores-summary", "scores-detail", "dashboard-baseline-score"])
    const client = seeded()
    invalidateScores(client)
    for (const key of SCORE_QUERY_KEYS) expect(invalidated(client, key)).toBe(true)
  })
})

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "f1", key: "score-stale:iso", family: "signals", check: "score-stale", severity: "low", state: "open", title: "Baseline score for ISO 27001 is stale",
  reason: "Last assessed long ago.", observedAt: null, evidenceAt: null, firstSeenAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-01T00:00:00Z",
  resolvedAt: null, occurrence: 1, owner: null, acknowledgedAt: null, acknowledgedBy: null, link: "/portal/governance/scores", history: [], ...overrides,
})
const lastRun = (status: string): Pick<Run, "status" | "finishedAt"> => ({ status, finishedAt: "2026-10-15T08:00:00Z" })

function renderList(findings: Finding[], run: Run | null) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, null, createElement(FindingsList, { tenant, findings, lastRun: run, readOnly: true, onChanged: () => undefined }))))
}

describe("health review findings", () => {
  it("tells a clean review apart from no review", () => {
    expect(emptyFindingsText(null, [])).toBe("No review has run yet. Backup status is unknown.")
    expect(emptyFindingsText(lastRun("completed"), [])).toMatch(/^No open findings in the latest review \(/)
    expect(emptyFindingsText(lastRun("partial"), [])).toMatch(/not a clean result/)
    expect(emptyFindingsText(lastRun("failed"), [])).toMatch(/did not complete/)
    const clean = renderList([], { ...lastRun("completed"), id: "r", summary: "", trigger: "manual", startedAt: "", missedWindows: 0, checks: [], counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, deliveries: [] })
    expect(clean).toContain("No open findings in the latest review")
    expect(clean).not.toContain("No review has run yet")
  })

  it("renders the link of each finding", () => {
    const html = renderList([finding()], null)
    expect(html).toContain('href="/portal/governance/scores"')
    expect(html).toContain(">Open</a>")
  })

  it("links an unreadable signals finding to the source that failed", () => {
    const failed = checkSignals(TENANT_A, [], false, [{ label: "baseline scores", link: "/portal/governance/scores" }])
    expect(failed.findings[0]).toMatchObject({ check: "signals-unavailable", link: "/portal/governance/scores" })
    expect(failed.findings[0]!.reason).toContain("Could not read: baseline scores.")
    expect(checkSignals(TENANT_A, [], false).findings[0]!.link).toBe("/portal/operations/health-review")
  })
})

describe("standards deviation", () => {
  it("shows unknown, never zero, when deviations are missing or policies could not be assessed", () => {
    expect(deviationLabel({ freshness: "fresh", deviations: null, unknownPolicies: null })).toEqual({ text: "deviation unknown", tone: "warning" })
    expect(deviationLabel({ freshness: "fresh", deviations: 0, unknownPolicies: 2 })).toEqual({ text: "deviation unknown for 2 policies", tone: "warning" })
    expect(deviationLabel({ freshness: "fresh", deviations: 3, unknownPolicies: 1 })).toEqual({ text: "3 deviations, 1 policy unknown", tone: "warning" })
    expect(deviationLabel({ freshness: "fresh", deviations: 0, unknownPolicies: 0 })).toEqual({ text: "0 deviations", tone: "success" })
    expect(deviationLabel({ freshness: "unknown", deviations: null, unknownPolicies: null }).text).toBe("deviation not assessed")
  })
})
