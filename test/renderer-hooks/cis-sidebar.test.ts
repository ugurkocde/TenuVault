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

import { CisBenchmarksNavigation } from "../../src/renderer/components/CisBenchmarksNavigation"
import { FrameworkNavigation } from "../../src/renderer/components/FrameworkNavigation"
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

function sidebarHarness(route: string) {
  return createElement(
    MemoryRouter,
    { initialEntries: [route] },
    createElement(CisBenchmarksNavigation, { linkClass: (active: boolean) => (active ? "sidebar-link active" : "sidebar-link") }),
  )
}

const LICENSE_EXPIRES_AT = "2030-01-01T00:00:00.000Z"

function keyTenant(tenantId: string, plan: "pro" | "msp", tenantLimit: number) {
  return { tenantId, signedIn: true, activated: true, entitled: true, source: "key" as const, plan, tenants: tenantLimit, expiresAt: LICENSE_EXPIRES_AT, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }
}

function communityTenant(tenantId: string) {
  return { tenantId, signedIn: true, activated: false, entitled: false, source: null, plan: "community" as const, tenants: null, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }
}

function entitledStatus(plan: "pro" | "msp") {
  const tenantLimit = plan === "msp" ? 10 : 2
  return { hasKey: true, keyState: "active" as const, keyMessage: null, keyHint: "****ABCD", persisted: true, offline: false, message: null, plan, tenantLimit, validUntil: null, communityTenantId: null, tenants: [keyTenant("t-entitled", plan, tenantLimit)] }
}

function communityStatus() {
  return { hasKey: false, keyState: "none" as const, keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: null, tenantLimit: null, validUntil: null, communityTenantId: "t-community", tenants: [communityTenant("t-community")] }
}

function mixedStatus() {
  return { hasKey: true, keyState: "active" as const, keyMessage: null, keyHint: "****ABCD", persisted: true, offline: false, message: null, plan: "pro" as const, tenantLimit: 2, validUntil: null, communityTenantId: "t-community", tenants: [keyTenant("t-entitled", "pro", 2), communityTenant("t-community")] }
}

function tenantRef(tenantId: string) {
  return { id: tenantId === "t-community" ? 1 : 2, name: tenantId, credentials: { tenantId, appId: "app-1", clientSecret: "secret" } }
}

describe("CIS Benchmarks top-level sidebar entry", () => {
  it("renders the CIS item after Operations placement with the internal flag on", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = entitledStatus("msp")
    const container = render(sidebarHarness("/portal/frameworks/cis-benchmarks"))
    await flush()
    const link = container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain("CIS Benchmarks")
    expect(link?.className).toContain("active")
    expect(link?.getAttribute("aria-current")).toBe("page")
  })

  it("omits the CIS item entirely with the internal flag off", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).toBeNull()
    expect(container.textContent).not.toContain("CIS Benchmarks")
  })

  it("does not mark the CIS item active on other pages", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = entitledStatus("msp")
    const container = render(sidebarHarness("/portal/operations"))
    await flush()
    const link = container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')
    expect(link).not.toBeNull()
    expect(link?.className).not.toContain("active")
    expect(link?.getAttribute("aria-current")).toBeNull()
  })

  it("renders the normal link on Pro", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = entitledStatus("pro")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).not.toBeNull()
    expect(container.querySelector("button")).toBeNull()
  })

  it("renders a muted Pro entry that opens the upgrade dialog instead of navigating, on Community", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = communityStatus()
    selectedTenantState.current = tenantRef("t-community")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).toBeNull()
    const button = container.querySelector("button")
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain("CIS Benchmarks")
    expect(button?.textContent).toContain("Pro")
    expect(button?.getAttribute("aria-disabled")).toBe("true")
    expect(button?.getAttribute("title")).toContain("Pro and MSP")
    expect(button?.hasAttribute("disabled")).toBe(false)
    button?.focus()
    expect(document.activeElement).toBe(button)
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await flush()
    expect(document.body.textContent).toContain("Included in TenuVault Pro and MSP")
  })

  it("shows the locked Pro entry for a selected Community tenant even when the machine is entitled", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = mixedStatus()
    selectedTenantState.current = tenantRef("t-community")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).toBeNull()
    const button = container.querySelector("button")
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain("CIS Benchmarks")
    expect(button?.textContent).toContain("Pro")
  })

  it("shows the enabled link after switching the selected tenant to the entitled one", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = mixedStatus()
    selectedTenantState.current = tenantRef("t-community")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).toBeNull()
    expect(container.querySelector("button")).not.toBeNull()
    selectedTenantState.current = tenantRef("t-entitled")
    const root = roots[roots.length - 1]
    await act(async () => {
      root?.render(sidebarHarness("/portal/dashboard"))
    })
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).not.toBeNull()
    expect(container.querySelector("button")).toBeNull()
  })

  it("falls back to the machine plan when no tenant is selected", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = entitledStatus("pro")
    selectedTenantState.current = null
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).not.toBeNull()
    expect(container.querySelector("button")).toBeNull()
  })

  it("shows the enabled link for a selected entitled tenant", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = mixedStatus()
    selectedTenantState.current = tenantRef("t-entitled")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).not.toBeNull()
    expect(container.querySelector("button")).toBeNull()
  })

  it("renders nothing while the license status is loading", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = null
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).toBeNull()
    expect(container.textContent).not.toContain("CIS Benchmarks")
  })
})

describe("FrameworkNavigation", () => {
  it("no longer lists CIS Benchmarks with the internal flag on", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const container = render(
      createElement(MemoryRouter, { initialEntries: ["/portal/frameworks"] }, createElement(FrameworkNavigation)),
    )
    await flush()
    const list = container.querySelector('[aria-label="Framework list"]')
    expect(list).not.toBeNull()
    expect(list?.textContent).not.toContain("CIS Benchmarks")
    expect(list?.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).toBeNull()
    expect(list?.textContent).toContain("ISO/IEC 27001:2022")
  })

  it("no longer lists CIS Benchmarks with the internal flag off", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    const container = render(
      createElement(MemoryRouter, { initialEntries: ["/portal/frameworks"] }, createElement(FrameworkNavigation)),
    )
    await flush()
    const list = container.querySelector('[aria-label="Framework list"]')
    expect(list?.textContent).not.toContain("CIS Benchmarks")
  })
})

describe("CIS Benchmarks route", () => {
  it("renders Load benchmark as step 1 with the Build Kit import as a secondary internal disclosure", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const container = render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/portal/frameworks/cis-benchmarks"] },
        createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) })),
      ),
    )
    await flush()
    expect(container.textContent).toContain("CIS Benchmarks")
    expect(container.querySelector("#cis-delivered-title")?.textContent).toBe("1. Load benchmark")
    expect(container.textContent).not.toContain("Import a CIS Build Kit")
    expect(container.textContent).not.toContain("Choose your policy pack")
    expect(container.textContent).not.toContain("Import policy JSON")
    const kit = [...container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent === "Build Kit import (internal use)")
    expect(kit).toBeDefined()
    expect(kit?.open).toBe(false)
    expect(kit?.textContent).toContain("Select Build Kit zip")
    expect(kit?.textContent).toContain("Select recommendation list JSON")
    const stepper = container.querySelector('nav[aria-label="CIS Benchmarks progress"] ol')
    expect(stepper).not.toBeNull()
    // The number shows once: in the marker. The label carries it only for screen readers.
    const visible = (item: Element) => [...item.querySelectorAll(":scope > span:not([aria-hidden])")].map((span) => [...span.childNodes].filter((node) => !(node instanceof Element && node.classList.contains("sr-only"))).map((node) => node.textContent).join("")).join("")
    expect([...stepper!.querySelectorAll("li")].map(visible)).toEqual(["Load benchmark", "Compare with tenant", "Review results"])
    expect([...stepper!.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["1Step 1: Load benchmark", "2Step 2: Compare with tenant", "3Step 3: Review results"])
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Load benchmark")
    const heading = [...container.querySelectorAll("h1")].find((item) => item.textContent === "CIS Benchmarks")
    expect(heading?.className).toContain("text-4xl")
    expect(heading?.className).toContain("font-light")
    const frameworksLinks = [...container.querySelectorAll('a[href="/portal/frameworks"]')]
    expect(frameworksLinks.some((link) => link.textContent.trim() === "Frameworks")).toBe(false)
  })

  async function renderSavedAssessment(extra: object = {}): Promise<HTMLDivElement> {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const tenantId = "11111111-1111-1111-1111-111111111111"
    selectedTenantState.current = { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId: "22222222-2222-2222-2222-222222222222" } }
    const policy = { name: "Synthetic policy", platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark: "synthetic-os", version: "9.9.9", level: "Level 1", sourceFile: "synthetic.json" },
      settings: [{ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: "synthetic_setting", choiceSettingValue: { value: "synthetic_on", children: [] } } }], ...extra }
    const assessment = { runId: "run-1", tenantId, frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", assessedAt: "2026-10-15T10:00:00Z", policyCount: 1,
      findings: [{ key: "0:0", policyIndex: 0, settingIndex: 0, policyName: "Synthetic policy", settingId: "synthetic_setting", status: "Missing", recommended: policy.settings[0]!.settingInstance, observed: [] }] }
    const workspace = { version: 1, tenantId, frameworkId: "cis-benchmarks", policies: [policy], reference: assessment.reference, updatedAt: "2026-10-15T10:00:00Z", history: [{ assessment, policies: [policy] }] }
    vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(path === "/api/cis-remediation" ? { deployments: [] } : workspace), { status: 200, headers: { "Content-Type": "application/json" } })))
    const container = render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/portal/frameworks/cis-benchmarks"] },
        createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) })),
      ),
    )
    await flush()
    const view = [...container.querySelectorAll("button")].find((item) => item.textContent === "View read-only")
    expect(view).toBeDefined()
    await act(async () => { view!.click() })
    await flush()
    return container
  }

  it("shows the CIS manual notice with its link in the readiness view without a manual recommendation list", async () => {
    const openExternal = vi.fn(async () => undefined)
    const { bridge } = await import("../../src/renderer/lib/bridge")
    ;(bridge.app as unknown as { openExternal: typeof openExternal }).openExternal = openExternal
    const container = await renderSavedAssessment()
    const notice = container.querySelector('[aria-label="CIS readiness"] [role="note"]')
    expect(notice?.textContent).toContain("Not all recommendations from the CIS Benchmarks are included in this tool. Please refer to the CIS website to access the free CIS Benchmarks PDFs for manual assessment instructions.")
    const link = notice?.querySelector("a")
    expect(link?.textContent).toBe("https://www.cisecurity.org/cis-benchmarks")
    await act(async () => { link!.click() })
    expect(openExternal).toHaveBeenCalledWith("https://www.cisecurity.org/cis-benchmarks")
    expect(container.textContent).not.toContain("Recommendation results")
    // Without a recommendation list the settings pass rate leads and identifier coverage stays.
    const summary = container.querySelector('[aria-label="Level 1 summary"]')
    expect(summary?.textContent).toContain("Pass rate")
    expect(summary?.textContent).not.toContain("Recommendation pass rate")
    expect(summary?.textContent).toContain("Enumerated identifiers")
    expect(container.textContent).toContain("Coverage and the assessed automated count need a denominator list")
    vi.unstubAllGlobals()
  })

  it("shows the recommendation identity on findings and the recommendation results when the pack lists them", async () => {
    const container = await renderSavedAssessment({ recommendations: [{ id: "7.1.1", title: "Synthetic recommendation", level: 1, settings: ["synthetic_setting"] }],
      provenance: { schemaVersion: 1, benchmark: "synthetic-os", version: "9.9.9", level: "Level 1", sourceFile: "synthetic.json", benchmarkName: "Synthetic Display Benchmark" } })
    const row = container.querySelector('[aria-label="Synthetic policy"]')
    expect(row?.textContent).toContain("7.1.1 Synthetic recommendation")
    expect(container.textContent).toContain("Recommendation results, Level 1: 0 passed, 1 failed, 0 not assessed")
    const summary = container.querySelector('[aria-label="Level 1 summary"]')
    expect(summary?.textContent).toContain("0%Recommendation pass rate")
    expect(summary?.textContent).toContain("Settings: 0 of 1 present")
    expect(summary?.textContent).toContain("Synthetic Display Benchmark · Level 1")
    expect(summary?.textContent).toContain("Recommendations not assessed")
    for (const hidden of ["Enumerated identifiers", "Assessed automated", "Coverage"]) expect(summary?.textContent).not.toContain(hidden)
    expect(container.textContent).not.toContain("need a denominator list")
    expect(container.textContent).toContain("Synthetic Display Benchmark 9.9.9 Level 1")
    expect(container.textContent).not.toContain("Synthetic Os")
    vi.unstubAllGlobals()
  })
})
