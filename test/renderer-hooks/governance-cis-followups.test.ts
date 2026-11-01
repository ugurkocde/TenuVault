import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appInfo = vi.hoisted(() => vi.fn())
const licenseStatus = vi.hoisted(() => ({ current: null as unknown }))
const selectedTenantState = vi.hoisted(() => ({ current: null as unknown }))
const tenantsState = vi.hoisted(() => ({ current: [] as unknown[] }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { app: { info: appInfo }, license: { open: async () => undefined } },
}))

vi.mock("../../src/renderer/lib/framework-jobs", () => ({
  useFrameworkJobs: () => [],
}))

// The selected tenant is a small store, so selecting another tenant re-renders like the real context.
const tenantListeners = vi.hoisted(() => new Set<() => void>())
vi.mock("../../src/portal/contexts/TenantContext", async () => {
  const React = await import("react")
  const subscribe = (listener: () => void) => { tenantListeners.add(listener); return () => { tenantListeners.delete(listener) } }
  return {
    useSelectedTenant: () => {
      const selectedTenant = React.useSyncExternalStore(subscribe, () => selectedTenantState.current)
      return { selectedTenant, selectedTenantId: null, setSelectedTenantId: (id: string) => { selectedTenantState.current = tenantsState.current.find(candidate => (candidate as { id: string }).id === id) ?? null; for (const listener of tenantListeners) listener() } }
    },
    useTenants: () => tenantsState.current,
  }
})

vi.mock("../../src/renderer/lib/license", () => {
  const tenantLicense = (status: { tenants: { tenantId: string }[] } | null, tenantId: string | undefined) => {
    const id = tenantId?.toLowerCase()
    return id ? status?.tenants.find((tenant) => tenant.tenantId === id) : undefined
  }
  const tenantPlan = (tenant: { entitled: boolean; plan: string | null } | undefined) => {
    if (!tenant) return null
    if (tenant.entitled) return tenant.plan
    return tenant.plan === "community" ? "community" : null
  }
  return {
    useTenantPlan: (tenantId: string | undefined) => tenantPlan(tenantLicense(licenseStatus.current as { tenants: { tenantId: string }[] } | null, tenantId) as { entitled: boolean; plan: string | null } | undefined),
    useLicense: () => ({ status: licenseStatus.current, error: null, refresh: async () => undefined }),
    tenantLicense,
    tenantPlan,
  }
})

vi.mock("../../src/portal/components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm: async () => false, confirmDialog: null }),
}))

import FrameworksPage from "../../src/renderer/pages/FrameworksPage"
import { CisCard } from "../../src/renderer/features/scores/CisCard"
import { cisCardPath, cisScoreCards } from "../../src/renderer/features/scores/cis"
import { PortfolioScores } from "../../src/renderer/features/scores/PortfolioScores"
import { controlTitle, ScoreDetail, SOURCE_CONTROLS_NOTE } from "../../src/renderer/features/scores/ScoreDetail"
import { StatusTiles } from "../../src/renderer/features/health-review/HealthReviewTab"
import { evidenceAge, type Finding as HealthFinding, type Status } from "../../src/renderer/features/health-review/api"
import { cisOpenRequest } from "../../src/shared/frameworks/cis-run"
import { cisReadiness, coverageStatement } from "../../src/shared/frameworks/cis-readiness"
import type { Tenant } from "../../src/portal/contexts/TenantContext"
import type { Finding } from "../../src/shared/frameworks/policies"
import { statusLabel } from "../../src/renderer/features/shared/change-set"
import { ageText } from "../../src/renderer/features/scores/api"
import { deploymentState } from "../../src/renderer/features/cis-remediation/CisRemediationHistory"
import { knownSettingName } from "../../src/shared/frameworks/cis-display"

const roots: Root[] = []
const containers: HTMLDivElement[] = []

function render(element: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  act(() => {
    const root = createRoot(container)
    roots.push(root)
    root.render(element as React.ReactElement)
  })
  return container
}

async function flush(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  licenseStatus.current = null
  selectedTenantState.current = null
  tenantsState.current = []
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const tenantId = "11111111-1111-1111-1111-111111111111"
const otherTenantId = "33333333-3333-3333-3333-333333333333"
const appId = "22222222-2222-2222-2222-222222222222"
const choice = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const setting = (id: string) => ({ settingInstance: { "@odata.type": choice, settingDefinitionId: id, choiceSettingValue: { value: `${id}_on`, children: [] } } })

/** A one-Level pack of a synthetic benchmark and a saved run of it with the given statuses. */
function savedRun(benchmark: string, name: string, runId: string, assessedAt: string, statuses: Finding["status"][], forTenant = tenantId, level: 1 | 2 = 1) {
  const policy = { name: `${name} policy`, platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark, benchmarkName: name, version: "1.0.0", level: `Level ${level}`, sourceFile: "synthetic.json" },
    settings: statuses.map((_, index) => setting(`${benchmark.replace(/-/g, "_")}_${index}`)) }
  const findings = statuses.map((status, index) => ({ key: `0:${index}`, policyIndex: 0, settingIndex: index, policyName: policy.name, settingId: (policy.settings[index]!.settingInstance as { settingDefinitionId: string }).settingDefinitionId, status, recommended: policy.settings[index]!.settingInstance, observed: [] }))
  const reference = `${benchmark} 1.0.0 Level ${level}`
  return { assessment: { runId, tenantId: forTenant, frameworkId: "cis-benchmarks", reference, assessedAt, policyCount: 1, findings }, policies: [policy] }
}

/** A workspace with an older Edge-like assessment and a newer Windows-like assessment, the Windows pack still loaded. */
function workspace() {
  const edge = savedRun("synthetic-edge", "Synthetic Edge", "run-edge", "2026-10-16T14:29:05Z", ["Present", "Missing", "Missing"])
  const windows = savedRun("synthetic-windows", "Synthetic Windows", "run-windows", "2026-10-16T23:29:00Z", ["Present"])
  return { version: 1, tenantId, frameworkId: "cis-benchmarks", policies: windows.policies, reference: windows.assessment.reference, updatedAt: windows.assessment.assessedAt, history: [windows, edge], exceptions: [] }
}

const localTenant = { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId } }
const otherTenant = { id: "other", name: "Other tenant", credentials: { tenantId: otherTenantId, appId } }

/** The other tenant's workspace: an older Level 2 run and a newer Level 1 run of one benchmark. */
function otherWorkspace() {
  const level2 = savedRun("synthetic-windows", "Synthetic Windows", "run-other-l2", "2026-10-15T16:34:00Z", ["Present", "Present"], otherTenantId, 2)
  const level1 = savedRun("synthetic-windows", "Synthetic Windows", "run-other-l1", "2026-10-16T09:00:00Z", ["Missing"], otherTenantId)
  return { version: 1, tenantId: otherTenantId, frameworkId: "cis-benchmarks", policies: level1.policies, reference: level1.assessment.reference, updatedAt: level1.assessment.assessedAt, history: [level1, level2], exceptions: [] }
}

/** A running assessment as main reports it next to the workspace. */
const runningJob = { jobId: "job-windows", reference: "synthetic-windows 1.0.0 Level 1", policies: workspace().policies }

async function renderCisPage(search: string, options: { activeJob?: typeof runningJob | null; tenants?: unknown[] } = {}): Promise<{ container: HTMLDivElement; fetch: ReturnType<typeof vi.fn> }> {
  appInfo.mockResolvedValue({ internalCisBenchmarks: true })
  selectedTenantState.current = localTenant
  tenantsState.current = options.tenants ?? []
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { action?: string; tenantId?: string }
    const saved = request.tenantId === otherTenantId ? otherWorkspace() : workspace()
    const body = path === "/api/cis-remediation" ? { deployments: [] } : request.action === "cis-catalog" ? { benchmarks: [] } : request.action === "cis-setting-names" ? { settings: {}, options: {} }
      : request.action === "workspace-open" ? { workspace: saved, activeJob: options.activeJob ?? null }
        : request.action === "assess-status" ? { jobId: "job-windows", phase: "reading", status: "running", state: "running", tenantId, frameworkId: "cis-benchmarks", read: 1, total: 4, currentPolicy: "", comparedPolicies: 0, packPolicies: 1, currentPackPolicy: "", findings: [], nextSince: 0, error: null, assessment: null }
          : saved
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
  })
  vi.stubGlobal("fetch", fetch)
  const container = render(createElement(MemoryRouter, { initialEntries: [`/portal/frameworks/cis-benchmarks${search}`] },
    createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) }))))
  await flush(4)
  return { container, fetch }
}

const statusPolls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.body).includes('"assess-status"')).length

describe("Governance CIS card links", () => {
  it("links to the exact saved run the card shows", () => {
    const [edgeCard] = cisScoreCards(true, { history: [workspace().history[1]!] }, tenantId)
    expect(cisCardPath(edgeCard!)).toBe("/portal/frameworks/cis-benchmarks?run=run-edge&benchmark=synthetic-edge&version=1.0.0&level=1")
    expect(cisCardPath(edgeCard!, otherTenantId)).toBe(`/portal/frameworks/cis-benchmarks?run=run-edge&benchmark=synthetic-edge&version=1.0.0&level=1&tenant=${otherTenantId}`)
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CisCard, { card: edgeCard! })))
    expect(markup).toContain('href="/portal/frameworks/cis-benchmarks?run=run-edge&amp;benchmark=synthetic-edge&amp;version=1.0.0&amp;level=1"')
  })

  it("names the Level the card rates, not an unassessed Level 1 of a Level 2 run", () => {
    const card = { key: "synthetic-windows", version: "1.0.0", runId: "run-other-l2", levels: [{ level: 1 as const, rate: null }, { level: 2 as const, rate: 100 }] } as unknown as Parameters<typeof cisCardPath>[0]
    expect(cisCardPath(card)).toBe("/portal/frameworks/cis-benchmarks?run=run-other-l2&benchmark=synthetic-windows&version=1.0.0&level=2")
  })

  it("reads the run from the link and ignores a Level it does not know", () => {
    expect(cisOpenRequest(new URLSearchParams("run=run-1&benchmark=synthetic-edge&version=1.0.0&level=2"))).toEqual({ runId: "run-1", benchmark: "synthetic-edge", version: "1.0.0", level: 2 })
    expect(cisOpenRequest(new URLSearchParams("run=run-1&level=7"))).toEqual({ runId: "run-1" })
    expect(cisOpenRequest(new URLSearchParams("benchmark=synthetic-edge&level=1"))).toBeNull()
  })

  it("opens the CIS page on the card's run, read-only, with the rate the card shows", async () => {
    const [edgeCard] = cisScoreCards(true, { history: [workspace().history[1]!] }, tenantId)
    const { container } = await renderCisPage("?run=run-edge&benchmark=synthetic-edge&version=1.0.0&level=1")
    const header = container.querySelector('[aria-label="Results header"]')!
    expect(header.textContent).toContain("Synthetic Edge 1.0.0 Level 1")
    expect(header.textContent).toContain("Showing a saved assessment.")
    const summary = container.querySelector('[aria-label="Level 1 summary"]')!
    expect(summary.textContent).toContain(`${edgeCard!.levels[0]!.rate}%`)
    expect(summary.textContent).toContain("33.3%")
    // A read-only result offers no selection: Select all deviating is disabled like the other actions.
    const selectAll = [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("Select all deviating"))!
    expect(selectAll.textContent).toBe("Select all deviating (2)")
    expect(selectAll.disabled).toBe(true)
  })

  it("keeps a requested run on screen while another assessment runs, and follows it only on View progress", async () => {
    const { container, fetch } = await renderCisPage("?run=run-edge&benchmark=synthetic-edge&version=1.0.0&level=1", { activeJob: runningJob })
    expect(container.querySelector('[aria-label="Results header"]')!.textContent).toContain("Synthetic Edge 1.0.0 Level 1")
    const notice = container.querySelector('[aria-label="Assessment running"]')!
    expect(notice.textContent).toContain("An assessment of Synthetic Windows 1.0.0 Level 1 is running.")
    expect(statusPolls(fetch)).toBe(0)
    await act(async () => { [...notice.querySelectorAll("button")].find(button => button.textContent === "View progress")!.click() })
    await flush(2)
    expect(statusPolls(fetch)).toBeGreaterThan(0)
    expect(container.querySelector('[aria-label="Assessment running"]')).toBeNull()
  })

  it("still follows a running assessment at once when no run was requested", async () => {
    const { container, fetch } = await renderCisPage("", { activeJob: runningJob })
    expect(container.querySelector('[aria-label="Assessment running"]')).toBeNull()
    expect(statusPolls(fetch)).toBeGreaterThan(0)
  })

  it("opens a Level 2 card's own Level 2 run even when a newer Level 1 run exists", async () => {
    const { container } = await renderCisPage(`?tenant=${otherTenantId}&run=run-other-l2&benchmark=synthetic-windows&version=1.0.0&level=2`, { tenants: [localTenant, otherTenant] })
    expect((selectedTenantState.current as { id: string }).id).toBe("other")
    const header = container.querySelector('[aria-label="Results header"]')!
    expect(header.textContent).toContain("Synthetic Windows 1.0.0 Level 2")
    expect(header.textContent).toContain("Other tenant")
    expect(container.querySelector('[aria-label="Level 2 summary"]')!.textContent).toContain("100%")
    expect(container.textContent).not.toContain("was not found")
  })

  it("opens the newest saved assessment with a short note when the requested run is gone", async () => {
    const { container } = await renderCisPage("?run=deleted-run&benchmark=unknown-benchmark&level=1")
    expect(container.textContent).toContain("The saved assessment of Unknown Benchmark Level 1 was not found, so the newest saved assessment is shown.")
    expect(container.querySelector('[aria-label="Results header"]')!.textContent).toContain("Synthetic Windows 1.0.0 Level 1")
  })

  it("opens the newest saved assessment without a note when no run is named", async () => {
    const { container } = await renderCisPage("")
    expect(container.textContent).not.toContain("was not found")
    expect(container.querySelector('[aria-label="Results header"]')!.textContent).toContain("Synthetic Windows 1.0.0 Level 1")
  })
})

describe("CIS coverage wording", () => {
  const level = { level: 1 as const, coverage: null, assessedAutomated: null, denominator: null, coverageSource: "none" as const, enumerated: 0, denominatorIdentifiers: [] as string[] }
  it("says plainly why coverage of the full benchmark is missing, even when recommendations are listed", () => {
    expect(coverageStatement(level)).toBe("Coverage of the full benchmark is not shown because the list of all its automated recommendations is not available.")
    expect(coverageStatement({ ...level, denominator: 0, coverageSource: "authoritative" })).toBe("Coverage of the full benchmark is not shown because the list of its recommendations marks none of Level 1 as automated.")
    expect(coverageStatement({ ...level, coverage: 0.75, assessedAutomated: 72, denominator: 96, coverageSource: "authoritative", enumerated: 80 })).toBe("Coverage: 75% (72 of 96 automated recommendations), source: CIS list of automated recommendations.")
    for (const text of [coverageStatement(level), coverageStatement({ ...level, denominator: 0, coverageSource: "authoritative" })]) expect(text).not.toMatch(/denominator|enumerated|identifier/i)
    // Mapped pack recommendations count even when no description names a number.
    expect(coverageStatement({ ...level, coverage: 1, assessedAutomated: 3, denominator: 3, coverageSource: "authoritative", enumerated: 0 })).toBe("Coverage: 100% (3 of 3 automated recommendations), source: CIS list of automated recommendations.")
    expect(coverageStatement({ ...level, coverage: 0, assessedAutomated: 0, denominator: 3, coverageSource: "authoritative", enumerated: 0 })).toMatch(/so none of them count\.$/)
  })

  it("tells a Level without an assessed pack apart from a missing list", () => {
    // The list covers Levels 1 and 2, but only the Level 1 pack was assessed.
    const policy = { name: "Level 1 policy", platforms: "windows10", technologies: "mdm", description: "Covers 1.1", provenance: { schemaVersion: 1, benchmark: "synthetic-os", version: "1.0.0", level: "Level 1", sourceFile: "synthetic.json" }, settings: [setting("synthetic_alpha")] }
    const assessment = { runId: "run", tenantId, frameworkId: "cis-benchmarks", reference: "synthetic-os 1.0.0 Level 1", assessedAt: "2026-10-16T10:00:00Z", policyCount: 1, findings: [{ key: "0:0", policyIndex: 0, settingIndex: 0, policyName: policy.name, settingId: "synthetic_alpha", status: "Present" as const, recommended: null, observed: [] }] }
    const list = { benchmark: "synthetic-os", version: "1.0.0", items: [{ identifier: "1.1", level: 1 as const, automated: true, title: "One" }, { identifier: "2.1", level: 2 as const, automated: true, title: "Two" }] }
    const summary = cisReadiness(assessment, [policy], undefined, list as never)
    const level2 = summary.levels.find(item => item.level === 2)!
    expect(coverageStatement(level2)).toBe("No policy pack for Level 2 was assessed, so coverage of the full benchmark is not shown for it.")
    expect(coverageStatement(summary.levels.find(item => item.level === 1)!)).toMatch(/^Coverage: 100% \(1 of 1 automated recommendations\)/)
    // Scores do not change: Level 2 has nothing assessed and no rate.
    expect(level2.assessedSettings).toBe(0)
    expect(level2.passRate).toBeNull()
  })
})

describe("Governance portfolio", () => {
  const tenant = { id: "a", name: "Ugur Koc Lab", credentials: { tenantId, appId } } as unknown as Tenant
  const other = { id: "b", name: "UgurLabs Production", credentials: { tenantId: otherTenantId, appId } } as unknown as Tenant

  async function renderPortfolio() {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    tenantsState.current = [tenant, other]
    licenseStatus.current = { tenants: [{ tenantId, entitled: true, plan: "msp" }, { tenantId: otherTenantId, entitled: true, plan: "msp" }] }
    // One exclusion in use, so the card reads "100% with 1 exclusion".
    const productionCis = { history: [savedRun("synthetic-windows", "Synthetic Windows", "run-prod", "2026-10-16T08:00:00Z", ["Missing"], otherTenantId)],
      exceptions: [{ id: "exc", benchmark: "synthetic-windows", version: "1.0.0", level: 1, policyName: "Synthetic Windows policy", settingId: "synthetic_windows_0", owner: "Owner", reason: "Reason", expiresOn: "2099-01-01", createdAt: "2026-10-01T00:00:00Z" }] }
    const rows = [
      { tenantId, tenantName: "Ugur Koc Lab", error: null, frameworks: [
        { frameworkId: "soc2", frameworkName: "SOC 2", state: "history-only", message: "Scored under older rules. Compare again to score. An app update changed how capabilities are counted.", score: null, coverage: null, unknown: null, gapCount: null, assessedAt: "2026-10-07T10:00:00Z", ageDays: null, stale: null, partial: null, version: null },
        { frameworkId: "oib-windows", frameworkName: "OIB Windows", state: "history-only", message: "Only single-policy validations are saved for this platform.", score: null, coverage: null, unknown: null, gapCount: null, assessedAt: "2026-10-08T10:00:00Z", ageDays: null, stale: null, partial: null, version: null },
      ] },
      { tenantId: otherTenantId, tenantName: "UgurLabs Production", error: null, frameworks: [{ frameworkId: "iso-27001", frameworkName: "ISO/IEC 27001:2022", state: "not-assessed", message: null, score: null, coverage: null, unknown: null, gapCount: null, assessedAt: null, ageDays: null, stale: null, partial: null, version: null }] },
    ]
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tenantId: string; action: string }
      if (path === "/api/scores") return Response.json({ formula: "", tenants: rows })
      if (path === "/api/frameworks" && body.action === "workspace-load") return Response.json(body.tenantId === otherTenantId ? productionCis : { history: [] })
      return Response.json({})
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(PortfolioScores, { tenant, plan: "msp", onDrill: () => undefined }))))
    await flush(2)
    const load = [...container.querySelectorAll("button")].find(button => button.textContent === "Load portfolio")!
    await act(async () => { load.click() })
    await flush(3)
    return container
  }

  it("shows the date and reason of results kept in history only, never an unknown date or no coverage", async () => {
    const container = await renderPortfolio()
    const text = container.textContent ?? ""
    expect(text).not.toContain("Unknown date")
    const soc2 = [...container.querySelectorAll("tr")].find(row => row.textContent?.includes("SOC 2"))!
    expect(soc2.textContent).toContain(new Date("2026-10-07T10:00:00Z").toLocaleDateString(undefined, { dateStyle: "medium" }))
    expect(soc2.textContent).toContain("Scored under older rules.")
    expect(soc2.textContent).not.toContain("None")
    const oib = [...container.querySelectorAll("tr")].find(row => row.textContent?.includes("OIB Windows"))!
    expect(oib.textContent).toContain("Only single-policy validations are saved")
  })

  it("lists a tenant's CIS results with its CIS card rate instead of claiming no saved comparison", async () => {
    const container = await renderPortfolio()
    const production = [...container.querySelectorAll("tr")].filter(row => row.textContent?.includes("UgurLabs Production"))
    expect(production.map(row => row.textContent).join(" ")).not.toContain("No saved comparison yet.")
    const cisRow = production.find(row => row.textContent?.includes("Synthetic Windows"))!
    expect(cisRow.textContent).toContain("Level 1 0%")
    expect(cisRow.textContent).toContain("CIS Benchmarks, version 1.0.0")
  })

  it("shows the rate with exclusions and its date as the CIS card does, and opens another tenant's run with that tenant", async () => {
    const container = await renderPortfolio()
    const cisRow = [...container.querySelectorAll("tr")].find(row => row.textContent?.includes("UgurLabs Production") && row.textContent.includes("Synthetic Windows"))!
    const [card] = cisScoreCards(true, { history: [savedRun("synthetic-windows", "Synthetic Windows", "run-prod", "2026-10-16T08:00:00Z", ["Missing"], otherTenantId)], exceptions: [{ id: "exc", benchmark: "synthetic-windows", version: "1.0.0", level: 1, policyName: "Synthetic Windows policy", settingId: "synthetic_windows_0", owner: "Owner", reason: "Reason", expiresOn: "2099-01-01", createdAt: "2026-10-01T00:00:00Z" }] }, otherTenantId)
    expect(card!.levels[0]!.withExclusions).toBe("100% with 1 exclusion")
    expect(cisRow.textContent).toContain("100% with 1 exclusion")
    expect(cisRow.textContent).toContain(`Exclusions as of ${new Date(`${card!.levels[0]!.exclusionsAsOf}T00:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" })}`)
    expect(cisRow.querySelector("a")!.getAttribute("href")).toBe(`/portal/frameworks/cis-benchmarks?run=run-prod&benchmark=synthetic-windows&version=1.0.0&level=1&tenant=${otherTenantId}`)
  })
})

describe("ISO source controls", () => {
  it("removes the control number a title repeats and notes why per-control counts add up to more", async () => {
    expect(controlTitle("8.1", "Endpoint evidence mapping 8.1")).toBe("Endpoint evidence mapping")
    expect(controlTitle("8.1", "User endpoint devices")).toBe("User endpoint devices")
    const tenant = { id: "a", name: "Lab", credentials: { tenantId, appId } } as unknown as Tenant
    const detail = { identity: { frameworkName: "ISO/IEC 27001:2022", frameworkVersion: "2022", platforms: ["windows"] }, versionDetail: null, freshness: { assessedAt: "2026-10-16T10:00:00Z", ageDays: 0, stale: false }, score: { score: 9.6, coverage: 96.3 },
      incompleteCollection: [], unassessedNote: null, unit: "capability", items: [], gaps: [],
      controls: [{ id: "8.1", title: "Endpoint evidence mapping 8.1", status: "notMet", capabilityIds: ["a", "b"], gapCapabilityIds: ["a", "b"], unavailable: null }, { id: "8.5", title: "Endpoint evidence mapping 8.5", status: "notMet", capabilityIds: ["a"], gapCapabilityIds: ["a"], unavailable: null }] }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tenantId, tenantName: "Lab", detail })))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = render(createElement(QueryClientProvider, { client }, createElement(ScoreDetail, { tenant, frameworkId: "iso-27001", onClose: () => undefined })))
    await flush(3)
    expect(container.textContent).toContain(SOURCE_CONTROLS_NOTE)
    const rows = [...container.querySelectorAll("tbody tr")].map(row => row.querySelector("td")!.textContent)
    expect(rows).toEqual(["8.1 Endpoint evidence mapping", "8.5 Endpoint evidence mapping"])
  })
})

describe("Health review header", () => {
  const now = Date.parse("2026-10-17T12:00:00Z")
  const finding = (overrides: Partial<HealthFinding>): HealthFinding => ({ id: "f", key: "k", family: "signals", check: "hygiene", severity: "low", state: "open", title: "Finding", reason: "Reason", observedAt: "2026-10-16T12:00:00Z", evidenceAt: null,
    firstSeenAt: "2026-10-06T00:00:00Z", lastSeenAt: "2026-10-17T00:00:00Z", resolvedAt: null, occurrence: 1, owner: null, acknowledgedAt: null, acknowledgedBy: null, link: "/portal/governance/hygiene", history: [], ...overrides })
  const status = { schedule: null, readiness: { state: "ready", message: "Ready", signedIn: true, licensed: true, note: "" }, lastRun: { id: "r", status: "completed", summary: "", trigger: "manual", startedAt: "", finishedAt: "2026-10-17T11:00:00Z", missedWindows: 0, checks: [], counts: { critical: 0, high: 1, medium: 0, low: 162, unknown: 0 }, deliveries: [] },
    counts: { critical: 0, high: 1, medium: 0, low: 162, unknown: 0 }, thresholds: {}, endpoints: [] } as unknown as Status

  it("finds the oldest evidence of the open findings and how many are older than 7 days", () => {
    const findings = [finding({ observedAt: "2026-10-06T17:22:07Z" }), finding({ observedAt: "2026-10-16T12:00:00Z", link: "/portal/backup" }), finding({ state: "resolved", observedAt: "2026-09-01T00:00:00Z" })]
    expect(evidenceAge(findings, now)).toEqual({ oldest: "2026-10-06T17:22:07Z", ageDays: 10, stale: 1, staleLink: "/portal/governance/hygiene" })
    expect(evidenceAge([], now)).toEqual({ oldest: null, ageDays: null, stale: 0, staleLink: null })
  })

  it("shows the evidence date, a stale warning with a way to refresh, and every severity", () => {
    const run = vi.fn()
    const container = render(createElement(MemoryRouter, null, createElement(StatusTiles, { status, findings: [finding({ observedAt: "2026-10-06T17:22:07Z" })], review: { run, running: false }, now })))
    expect(container.textContent).toContain("Evidence from")
    expect(container.textContent).toContain(new Date("2026-10-06T17:22:07Z").toLocaleDateString(undefined, { dateStyle: "medium" }))
    expect(container.textContent).toContain("10 days old")
    expect(container.textContent).toContain("0 critical, 1 high, 0 medium, 162 low, 0 with unknown evidence")
    const warning = container.querySelector('[aria-label="Stale evidence"]')!
    expect(warning.textContent).toContain("1 open finding is based on evidence older than 7 days")
    expect(warning.querySelector("a")!.getAttribute("href")).toBe("/portal/governance/hygiene")
    expect(warning.querySelector("a")!.textContent).toBe("Scan the latest backup in Conflicts and hygiene")
    act(() => { [...warning.querySelectorAll("button")].find(button => button.textContent === "Review now")!.click() })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("shows no warning while the evidence is recent", () => {
    const container = render(createElement(MemoryRouter, null, createElement(StatusTiles, { status, findings: [finding({})], now })))
    expect(container.querySelector('[aria-label="Stale evidence"]')).toBeNull()
    expect(container.textContent).toContain("1 day old")
  })
})

describe("Plain labels", () => {
  it("shows a change set in review in words and a setting id once when no name was read", () => {
    expect(statusLabel("in-review")).toBe("in review")
    expect(statusLabel("applied")).toBe("applied")
    expect(deploymentState({ status: "in-review", rollbackChangeSetId: null, rollbackStatus: null } as never).label).toBe("in review")
    const id = "com.apple.systempolicy.control_com.apple.systempolicy.control"
    expect(knownSettingName(id, { settings: {}, options: {} })).toBeNull()
    expect(knownSettingName(id, { settings: { [id]: "Enable Assessment" }, options: {} })).toBe("Enable Assessment")
    // Graph names every top-level group collection this way, which names no setting.
    expect(knownSettingName(id, { settings: { [id]: "Top Level Setting Group Collection" }, options: {} })).toBeNull()
  })

  it("says today instead of 0 days ago, and never today for yesterday's date", () => {
    const now = new Date(2026, 9, 17, 1, 30)
    expect(ageText(new Date(2026, 9, 17, 0, 10).toISOString(), 0, now)).toBe("today")
    expect(ageText(new Date(2026, 9, 16, 23, 29).toISOString(), 0, now)).toBe("less than a day ago")
    expect(ageText(new Date(2026, 9, 14).toISOString(), 3, now)).toBe("3 days ago")
    expect(ageText(new Date(2026, 9, 16).toISOString(), 1, now)).toBe("1 day ago")
    expect(ageText("", null, now)).toBeNull()
  })
})
