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

vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: selectedTenantState.current, selectedTenantId: null, setSelectedTenantId: () => undefined }),
  useTenants: () => tenantsState.current,
}))

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
import { coverageStatement } from "../../src/shared/frameworks/cis-readiness"
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
function savedRun(benchmark: string, name: string, runId: string, assessedAt: string, statuses: Finding["status"][], forTenant = tenantId) {
  const policy = { name: `${name} policy`, platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark, benchmarkName: name, version: "1.0.0", level: "Level 1", sourceFile: "synthetic.json" },
    settings: statuses.map((_, index) => setting(`${benchmark.replace(/-/g, "_")}_${index}`)) }
  const findings = statuses.map((status, index) => ({ key: `0:${index}`, policyIndex: 0, settingIndex: index, policyName: policy.name, settingId: (policy.settings[index]!.settingInstance as { settingDefinitionId: string }).settingDefinitionId, status, recommended: policy.settings[index]!.settingInstance, observed: [] }))
  const reference = `${benchmark} 1.0.0 Level 1`
  return { assessment: { runId, tenantId: forTenant, frameworkId: "cis-benchmarks", reference, assessedAt, policyCount: 1, findings }, policies: [policy] }
}

/** A workspace with an older Edge-like assessment and a newer Windows-like assessment, the Windows pack still loaded. */
function workspace() {
  const edge = savedRun("synthetic-edge", "Synthetic Edge", "run-edge", "2026-10-16T14:29:05Z", ["Present", "Missing", "Missing"])
  const windows = savedRun("synthetic-windows", "Synthetic Windows", "run-windows", "2026-10-16T23:29:00Z", ["Present"])
  return { version: 1, tenantId, frameworkId: "cis-benchmarks", policies: windows.policies, reference: windows.assessment.reference, updatedAt: windows.assessment.assessedAt, history: [windows, edge], exceptions: [] }
}

async function renderCisPage(search: string): Promise<HTMLDivElement> {
  appInfo.mockResolvedValue({ internalCisBenchmarks: true })
  selectedTenantState.current = { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId } }
  const saved = workspace()
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const opening = path === "/api/frameworks" && String(init?.body).includes('"workspace-open"')
    const body = path === "/api/cis-remediation" ? { deployments: [] } : String(init?.body).includes('"cis-catalog"') ? { benchmarks: [] } : String(init?.body).includes('"cis-setting-names"') ? { settings: {}, options: {} } : opening ? { workspace: saved, activeJob: null } : saved
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
  }))
  const container = render(createElement(MemoryRouter, { initialEntries: [`/portal/frameworks/cis-benchmarks${search}`] },
    createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) }))))
  await flush(3)
  return container
}

describe("Governance CIS card links", () => {
  it("names the card's benchmark, version and Level in the CIS page link", () => {
    const [edgeCard] = cisScoreCards(true, { history: [workspace().history[1]!] }, tenantId)
    expect(cisCardPath(edgeCard!)).toBe("/portal/frameworks/cis-benchmarks?benchmark=synthetic-edge&version=1.0.0&level=1")
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CisCard, { card: edgeCard! })))
    expect(markup).toContain('href="/portal/frameworks/cis-benchmarks?benchmark=synthetic-edge&amp;version=1.0.0&amp;level=1"')
  })

  it("reads the request from the link and ignores a Level it does not know", () => {
    expect(cisOpenRequest(new URLSearchParams("benchmark=synthetic-edge&version=1.0.0&level=2"))).toEqual({ benchmark: "synthetic-edge", version: "1.0.0", level: 2 })
    expect(cisOpenRequest(new URLSearchParams("benchmark=synthetic-edge&level=7"))).toEqual({ benchmark: "synthetic-edge" })
    expect(cisOpenRequest(new URLSearchParams("level=1"))).toBeNull()
  })

  it("opens the CIS page on the card's benchmark, read-only, with the rate the card shows", async () => {
    const [edgeCard] = cisScoreCards(true, { history: [workspace().history[1]!] }, tenantId)
    const container = await renderCisPage("?benchmark=synthetic-edge&version=1.0.0&level=1")
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

  it("opens the newest saved assessment with a short note when the requested benchmark has none", async () => {
    const container = await renderCisPage("?benchmark=unknown-benchmark&level=1")
    expect(container.textContent).toContain("No saved assessment of Unknown Benchmark Level 1 was found, so the newest saved assessment is shown.")
    expect(container.querySelector('[aria-label="Results header"]')!.textContent).toContain("Synthetic Windows 1.0.0 Level 1")
  })

  it("opens the newest saved assessment without a note when no benchmark is named", async () => {
    const container = await renderCisPage("")
    expect(container.textContent).not.toContain("No saved assessment of")
    expect(container.querySelector('[aria-label="Results header"]')!.textContent).toContain("Synthetic Windows 1.0.0 Level 1")
  })
})

describe("CIS coverage wording", () => {
  const level = { level: 1 as const, coverage: null, assessedAutomated: null, denominator: null, coverageSource: "none" as const, enumerated: 0 }
  it("says plainly why coverage of the full benchmark is missing, even when recommendations are listed", () => {
    expect(coverageStatement(level)).toBe("Coverage of the full benchmark is not shown because the list of all its automated recommendations is not available.")
    expect(coverageStatement({ ...level, denominator: 0, coverageSource: "authoritative" })).toBe("Coverage of the full benchmark is not shown because the list of its recommendations marks none of Level 1 as automated.")
    expect(coverageStatement({ ...level, coverage: 0.75, assessedAutomated: 72, denominator: 96, coverageSource: "authoritative", enumerated: 80 })).toBe("Coverage: 75% (72 of 96 automated recommendations), source: CIS list of automated recommendations.")
    for (const text of [coverageStatement(level), coverageStatement({ ...level, denominator: 0, coverageSource: "authoritative" })]) expect(text).not.toMatch(/denominator|enumerated|identifier/i)
  })
})

describe("Governance portfolio", () => {
  const tenant = { id: "a", name: "Ugur Koc Lab", credentials: { tenantId, appId } } as unknown as Tenant
  const other = { id: "b", name: "UgurLabs Production", credentials: { tenantId: otherTenantId, appId } } as unknown as Tenant

  async function renderPortfolio() {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    tenantsState.current = [tenant, other]
    licenseStatus.current = { tenants: [{ tenantId, entitled: true, plan: "msp" }, { tenantId: otherTenantId, entitled: true, plan: "msp" }] }
    const productionCis = { history: [savedRun("synthetic-windows", "Synthetic Windows", "run-prod", "2026-10-16T08:00:00Z", ["Missing"], otherTenantId)] }
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
