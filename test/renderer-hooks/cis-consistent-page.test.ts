import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appInfo = vi.hoisted(() => vi.fn())
const licenseStatus = vi.hoisted(() => ({ current: null as unknown }))
const selectedTenantState = vi.hoisted(() => ({ current: null as unknown }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { app: { info: appInfo }, license: { open: async () => undefined } },
}))

vi.mock("../../src/renderer/lib/framework-jobs", () => ({
  useFrameworkJobs: () => [],
}))

vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: selectedTenantState.current, selectedTenantId: null, setSelectedTenantId: () => undefined }),
  useTenants: () => [],
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
import { humanSettingLabel } from "../../src/shared/frameworks/cis-display"
import { CIS_NOTICE } from "../../src/shared/frameworks/cis-certification"
import { MANUAL_NOT_ASSESSED_NOTE } from "../../src/shared/frameworks/cis-readiness"

const roots: Root[] = []
const containers: HTMLDivElement[] = []

function render(element: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  let root: Root
  act(() => {
    root = createRoot(container)
    roots.push(root)
    root.render(element as React.ReactElement)
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  licenseStatus.current = null
  selectedTenantState.current = null
  vi.clearAllMocks()
})

const tenantId = "11111111-1111-1111-1111-111111111111"
const choice = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const setting = (id: string) => ({ settingInstance: { "@odata.type": choice, settingDefinitionId: id, choiceSettingValue: { value: `${id}_on`, children: [] } } })

/** A saved assessment of one Level 1 pack, with exceptions in use, fixed and expired, opened read-only like after a reload. */
async function renderSaved(): Promise<HTMLDivElement> {
  appInfo.mockResolvedValue({ internalCisBenchmarks: true })
  selectedTenantState.current = { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId: "22222222-2222-2222-2222-222222222222" } }
  const policy = { name: "Synthetic policy", platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark: "synthetic-os", version: "9.9.9", level: "Level 1", sourceFile: "synthetic.json" },
    settings: [setting("synthetic_alpha"), setting("synthetic_beta"), setting("synthetic_gamma")] }
  const unassigned = { state: "unassigned", targets: [], limitations: [] }
  const finding = (index: number, status: string, observed: unknown[] = []) => ({ key: `0:${index}`, policyIndex: 0, settingIndex: index, policyName: "Synthetic policy", settingId: (policy.settings[index]!.settingInstance as { settingDefinitionId: string }).settingDefinitionId, status, recommended: policy.settings[index]!.settingInstance, observed })
  const assessment = { runId: "run-1", tenantId, frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", assessedAt: "2026-10-15T10:00:00Z", policyCount: 1,
    findings: [finding(0, "Missing"), finding(1, "Present", [{ policyId: "p1", policyName: "Tenant policy", value: policy.settings[1]!.settingInstance, targeting: unassigned }]), finding(2, "Review")] }
  const exception = (id: string, settingId: string, expiresOn: string) => ({ id, benchmark: "synthetic-os", version: "9.9.9", level: 1, policyName: "Synthetic policy", settingId, owner: "Owner", reason: `Reason ${id}`, expiresOn, createdAt: "2026-10-15T12:00:00Z" })
  const workspace = { version: 1, tenantId, frameworkId: "cis-benchmarks", policies: [policy], reference: assessment.reference, updatedAt: "2026-10-15T10:00:00Z", history: [{ assessment, policies: [policy] }],
    exceptions: [exception("exc-alpha", "synthetic_alpha", "2099-01-01"), exception("exc-beta", "synthetic_beta", "2099-01-01"), exception("exc-gamma", "synthetic_gamma", "2026-10-15")] }
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const opening = path === "/api/frameworks" && String(init?.body).includes('"workspace-open"')
    return new Response(JSON.stringify(path === "/api/cis-remediation" ? { deployments: [] } : opening ? { workspace, activeJob: null } : workspace), { status: 200, headers: { "Content-Type": "application/json" } })
  }))
  const container = render(createElement(MemoryRouter, { initialEntries: ["/portal/frameworks/cis-benchmarks"] },
    createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) }))))
  await flush()
  return container
}

describe("CIS page numbers", () => {
  it("shows one headline with the rate with exclusions, the unassigned line and every stored exception", async () => {
    const container = await renderSaved()
    const summary = container.querySelector('[aria-label="Level 1 summary"]')!
    expect(summary.textContent).toContain("33.3%")
    expect(summary.textContent).toContain("Settings pass rate")
    expect(summary.textContent).toContain("66.7% with 1 exclusion")
    expect(summary.textContent).toContain("Exclusions as of")
    expect(summary.textContent).toContain("1 of 1 present setting is in unassigned policies. CIS checks configuration; Governance scores count assigned policies only.")
    expect(summary.textContent).not.toMatch(/Adjusted/i)
    // The stat and the panel count the same exclusions in use.
    expect(summary.textContent).toContain("Excluded from score1")
    const panel = [...container.querySelectorAll("details")].find(item => item.querySelector("summary")?.id === "cis-exclusions")!
    expect(panel.querySelector("summary")?.textContent).toBe("Excluded from score: 1, 2 stored but not in use")
    expect(panel.textContent).toContain("Settings pass rate 33.3%, 66.7% with 1 exclusion.")
    expect(panel.textContent).toContain("Not in use: setting currently present")
    expect(panel.textContent).toContain("Expired")
    expect(panel.textContent).toContain("Reason exc-alpha")
    // Every stored exception stays listed with a Remove button; saved results are read-only until run again.
    const removes = [...panel.querySelectorAll("button")].filter(item => item.textContent === "Remove")
    expect(removes).toHaveLength(3)
    expect(removes.every(item => item.disabled)).toBe(true)
  })

  it("marks the excluded finding, never lets a Review finding be selected and names saved runs by time and rate", async () => {
    const container = await renderSaved()
    // The checkbox is named by the setting, not its raw id.
    expect(container.querySelector(`input[aria-label="Select finding ${humanSettingLabel("synthetic_alpha")} from Synthetic policy"]`)).not.toBeNull()
    const row = (settingId: string) => [...container.querySelectorAll('[aria-label="Assessment results"] summary')].find(item => item.textContent?.includes(settingId))!.closest("details")!.parentElement!
    expect(row("synthetic_alpha").textContent).toContain("Excluded")
    expect(row("synthetic_beta").textContent).not.toContain("Excluded")
    expect(row("synthetic_gamma").textContent).not.toContain("Excluded")
    // A Review finding has no checkbox, only a spacer of the same width, so its title lines up with the others.
    expect(container.querySelector('input[aria-label="Select finding Synthetic gamma from Synthetic policy"]')).toBeNull()
    // Present findings never get one either.
    expect(container.querySelector('input[aria-label="Select finding Synthetic beta from Synthetic policy"]')).toBeNull()
    for (const id of ["synthetic_beta", "synthetic_gamma"]) expect(row(id).firstElementChild?.matches('span[aria-hidden="true"].w-4.shrink-0')).toBe(true)
    const saved = container.querySelector('[aria-label="Saved assessment history"]')!
    // The reference already names the Level, so the row shows the rate once.
    expect(saved.textContent).toContain("synthetic-os 9.9.9 Level 1 · 33.3% · 3 findings")
    expect(saved.textContent).toMatch(/2026.*\d{1,2}:\d{2}/)
    const trend = container.querySelector('[aria-label="Trend for Synthetic Os 9.9.9"]')
    expect(trend?.textContent).toContain("First assessment")
    // The column names the basis of the rate, as the headline does.
    expect(trend?.textContent).toContain("Level 1 settings pass rate")
    expect(trend?.textContent).toContain("66.7% with 1 exclusion")
  })

  it("gives the benchmark name and the unassigned note full width lines and says once what is not checked", async () => {
    const container = await renderSaved()
    const summary = container.querySelector('[aria-label="Level 1 summary"]')!
    const grid = summary.querySelector(".grid")!
    // The name is its own line above the score row, not inside the narrow score column.
    const name = summary.firstElementChild!
    expect(name.textContent).toContain("Level 1")
    expect(name.textContent).toContain("9.9.9")
    expect(grid.contains(name)).toBe(false)
    // The unassigned caveat keeps its text as a neutral note under the bar row.
    const note = summary.querySelector('[role="note"]')!
    expect(note.textContent).toBe("1 of 1 present setting is in unassigned policies. CIS checks configuration; Governance scores count assigned policies only.")
    expect(grid.contains(note)).toBe(false)
    expect(note.className).toContain("bg-gray-50")
    expect(note.className).toContain("text-gray-700")
    // The readiness block no longer repeats the header note; the CIS notice stays word for word.
    const readiness = container.querySelector('[aria-label="CIS readiness"]')!
    expect(readiness.textContent).not.toContain(MANUAL_NOT_ASSESSED_NOTE)
    expect(readiness.textContent).not.toContain("This view covers the automated settings in the benchmark pack only.")
    expect(readiness.querySelector('[aria-label="Manual recommendations"]')?.textContent).toBe(`${CIS_NOTICE.text} ${CIS_NOTICE.url}`)
  })

  it("lines up finding titles, marks the shown saved run and shows Portfolio as a titled card", async () => {
    const container = await renderSaved()
    // Every status badge has one fixed width with centered text, so the titles after it start at the same place.
    const badges = [...container.querySelectorAll('[aria-label="Assessment results"] section summary > span:first-child')]
    expect(badges.map(badge => badge.textContent)).toEqual(["Missing", "Present", "Review"])
    for (const badge of badges) expect([badge.classList.contains("w-[5.5rem]"), badge.classList.contains("text-center")]).toEqual([true, true])
    // The saved run on screen is marked Shown; showing it again is unavailable with the reason, Delete stays.
    const saved = container.querySelector('[aria-label="Saved assessment history"]')!
    const row = saved.querySelector(".border-t")!
    expect([...row.querySelectorAll("span")].some(span => span.textContent === "Shown")).toBe(true)
    const view = [...row.querySelectorAll("button")].find(item => item.textContent === "View read-only")!
    expect(view.disabled).toBe(true)
    expect(view.title).toBe("Already shown")
    expect(view.getAttribute("aria-label")).toBe("View read-only, already shown")
    expect([...row.querySelectorAll("button")].find(item => item.textContent === "Delete")?.disabled).toBe(false)
    // Portfolio is a collapsed card with a heading and one line on what it shows.
    const portfolio = container.querySelector('details[aria-label="Portfolio"]') as HTMLDetailsElement
    expect(portfolio.open).toBe(false)
    expect(portfolio.className).toContain("rounded-3xl")
    expect(portfolio.querySelector("summary h2")?.textContent).toBe("Portfolio")
    expect(portfolio.querySelector("summary")?.textContent).toContain("from each tenant's newest saved assessment of one benchmark")
    expect(portfolio.querySelector('[aria-label="CIS portfolio"] h2')).toBeNull()
  })
})
