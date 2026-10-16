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
    const row = (settingId: string) => container.querySelector(`input[aria-label="Select finding ${settingId} from Synthetic policy"]`)!.closest("div")!
    expect(row("synthetic_alpha").textContent).toContain("Excluded")
    expect(row("synthetic_beta").textContent).not.toContain("Excluded")
    expect(row("synthetic_gamma").textContent).not.toContain("Excluded")
    expect((container.querySelector('input[aria-label="Select finding synthetic_gamma from Synthetic policy"]') as HTMLInputElement).disabled).toBe(true)
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
})
