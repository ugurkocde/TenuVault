import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appInfo = vi.hoisted(() => vi.fn())
const licenseStatus = vi.hoisted(() => ({ current: null as unknown }))
const selectedTenantState = vi.hoisted(() => ({ current: null as unknown }))
// Tenants the account store has a sign-in for; undefined while it is not read yet.
const signedInIds = vi.hoisted(() => ({ current: undefined as ReadonlySet<string> | undefined }))

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
    useLicense: () => ({ status: licenseStatus.current, signedInTenantIds: signedInIds.current, error: null, refresh: async () => undefined }),
    isUnlicensed: (status: { hasKey: boolean; tenants: { activated: boolean }[] }) => !status.hasKey && !status.tenants.some((tenant) => tenant.activated),
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
import { CIS_CERTIFICATION_HEADLINE, CIS_CERTIFIED_SEGMENTS, CIS_REMEDIATION_LIMITS, certifiedScopeLines, cisCheckCount, cisCheckCountText } from "../../src/shared/frameworks/cis-certification"
import { CIS_PLAN_ADDITIONS } from "../../src/renderer/features/cis-preview/CisBenchmarksPreview"

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
  signedInIds.current = undefined
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
  it("renders the CIS item after Operations placement", async () => {
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

  it("shows the CIS item by plan without the internal claim: a link on Pro, a link with the plan badge on Community", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = entitledStatus("pro")
    const pro = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(pro.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')?.textContent).toBe("CIS Benchmarks")
    licenseStatus.current = communityStatus()
    selectedTenantState.current = tenantRef("t-community")
    const community = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(community.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')?.textContent).toBe("CIS BenchmarksPro")
    expect(community.querySelector("button")).toBeNull()
    expect(community.textContent).not.toContain("Coming soon")
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

  it("opens the CIS page from the Community entry, which keeps its plan badge", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = communityStatus()
    selectedTenantState.current = tenantRef("t-community")
    const container = render(createElement(
      MemoryRouter,
      { initialEntries: ["/portal/dashboard"] },
      createElement(CisBenchmarksNavigation, { linkClass: (active: boolean) => (active ? "sidebar-link active" : "sidebar-link") }),
      createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/cis-benchmarks", element: createElement("p", null, "CIS page opened") }), createElement(Route, { path: "*", element: null })),
    ))
    await flush()
    expect(container.querySelector("button")).toBeNull()
    const link = container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain("CIS Benchmarks")
    expect(link?.textContent).toContain("Pro")
    expect(link?.hasAttribute("aria-disabled")).toBe(false)
    expect(link?.textContent).not.toContain("CIS Controls")
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
    })
    await flush()
    expect(container.textContent).toContain("CIS page opened")
    expect(link?.getAttribute("aria-current")).toBe("page")
    // No dialog: the page itself explains the plan.
    expect(document.body.textContent).not.toContain("Included in TenuVault Pro and MSP")
  })

  it("shows the plan badge for a selected Community tenant even when the machine is entitled", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = mixedStatus()
    selectedTenantState.current = tenantRef("t-community")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector("button")).toBeNull()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')?.textContent).toBe("CIS BenchmarksPro")
  })

  it("shows the enabled link after switching the selected tenant to the entitled one", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = mixedStatus()
    selectedTenantState.current = tenantRef("t-community")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')?.textContent).toBe("CIS BenchmarksPro")
    selectedTenantState.current = tenantRef("t-entitled")
    const root = roots[roots.length - 1]
    await act(async () => {
      root?.render(sidebarHarness("/portal/dashboard"))
    })
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')?.textContent).toBe("CIS Benchmarks")
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

  it("renders the normal entry while the license status is loading, without the upgrade state", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = null
    selectedTenantState.current = tenantRef("t-entitled")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    // No plan badge until the plan is known.
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')?.textContent).toBe("CIS Benchmarks")
    expect(container.querySelector("button")).toBeNull()
    licenseStatus.current = entitledStatus("pro")
    const root = roots[roots.length - 1]
    await act(async () => { root?.render(sidebarHarness("/portal/dashboard")) })
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).not.toBeNull()
    expect(container.querySelector("button")).toBeNull()
  })

  it("uses the account plan for a selected tenant that is not signed in", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = communityStatus()
    selectedTenantState.current = { id: 3, name: "Not signed in", credentials: undefined }
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')?.textContent).toBe("CIS BenchmarksPro")
  })

  it("renders the normal entry while the status does not list the selected tenant yet", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = communityStatus()
    signedInIds.current = new Set(["t-community", "t-entitled"])
    selectedTenantState.current = tenantRef("t-entitled")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).not.toBeNull()
    expect(container.querySelector("button")).toBeNull()
  })

  it("uses the machine plan for a saved tenant profile that is not signed in, not the activation the status lists for it", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const status = entitledStatus("msp")
    licenseStatus.current = { ...status, tenants: [{ ...keyTenant("t-lapsed", "msp", 10), signedIn: false, entitled: false }] }
    signedInIds.current = new Set()
    selectedTenantState.current = tenantRef("t-lapsed")
    const container = render(sidebarHarness("/portal/dashboard"))
    await flush()
    expect(container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')?.textContent).toBe("CIS Benchmarks")
  })
})

describe("FrameworkNavigation", () => {
  it("lists CIS Controls as Coming soon and leaves CIS Benchmarks to its own entry", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    const container = render(
      createElement(MemoryRouter, { initialEntries: ["/portal/frameworks"] }, createElement(FrameworkNavigation)),
    )
    await flush()
    const list = container.querySelector('[aria-label="Framework list"]')
    expect(list).not.toBeNull()
    expect(list?.textContent).not.toContain("CIS Benchmarks")
    expect(list?.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')).toBeNull()
    expect(list?.textContent).toContain("ISO/IEC 27001:2022")
    expect(list?.textContent).toContain("CIS ControlsComing soon")
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

  function renderCisRoute(): HTMLDivElement {
    return render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/portal/frameworks/cis-benchmarks"] },
        createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) })),
      ),
    )
  }

  it("opens the CIS page without the internal claim, states the certified scope and hides the Build Kit import", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    const container = renderCisRoute()
    await flush()
    expect(container.querySelector("#cis-delivered-title")?.textContent).toBe("1. Load benchmark")
    expect(container.textContent).not.toContain("Coming soon")
    expect(container.textContent).not.toContain("Build Kit import")
    const note = container.querySelector('[aria-label="CIS certification"]')
    expect(note?.textContent).toContain(CIS_CERTIFICATION_HEADLINE)
    for (const line of certifiedScopeLines()) expect(note?.textContent).toContain(line)
    expect(note?.textContent).toContain("Other CIS Benchmarks, versions and Levels are not certified.")
  })

  function communityPage(status: unknown = communityStatus()) {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = status
    selectedTenantState.current = tenantRef("t-community")
    const workspace = { version: 1, tenantId: "t-community", frameworkId: "cis-benchmarks", policies: [], reference: "", updatedAt: "", history: [] }
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = String(init?.body)
      if (body.includes("cis-sample-pdf")) return Response.json({ name: "TenuVault sample CIS readiness report (sample data).pdf", saved: true, path: "/Users/admin/Documents/TenuVault sample CIS readiness report (sample data).pdf" })
      return Response.json(body.includes("workspace-open") ? { workspace, activeJob: null } : workspace)
    })
    vi.stubGlobal("fetch", fetch)
    return { container: renderCisRoute(), fetch }
  }
  /** The labels of the preview actions, buttons and the License page link, in order. */
  const previewActions = (preview: Element) => [...preview.querySelectorAll("button, a")].map((item) => item.textContent)
  /** Every request body the page sent, by action. */
  const actions = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")).action as string)

  it("shows Community the preview of what Pro and MSP add instead of the benchmark picker, with no CIS content request", async () => {
    const { container, fetch } = communityPage()
    await flush()
    const preview = container.querySelector('[aria-label="CIS Benchmarks assessments, remediation and reports preview"]')
    expect(preview).not.toBeNull()
    expect(preview?.textContent).toContain("Pro")
    // The certification statement and every certified benchmark Level with its automatic check count.
    expect(preview?.textContent).toContain(CIS_CERTIFICATION_HEADLINE)
    expect(preview?.textContent).toContain("Other CIS Benchmarks, versions and Levels are not certified.")
    for (const segment of CIS_CERTIFIED_SEGMENTS) {
      expect(preview?.textContent).toContain(segment.name)
      for (const level of segment.levels) expect(preview?.textContent).toContain(cisCheckCountText(cisCheckCount(segment.benchmark, segment.version, level)!))
    }
    expect(preview?.textContent).toContain("TenuVault checks 274 of 308 recommendations automatically; the rest are listed for a manual check.")
    expect(preview?.textContent).toContain("TenuVault checks 88 of 90 recommendations automatically; the rest are listed for a manual check.")
    expect(preview?.textContent).toContain("TenuVault checks all 52 recommendations automatically.")
    // What the plans add, then the ways to get them.
    for (const line of CIS_PLAN_ADDITIONS) expect(preview?.textContent).toContain(line)
    // The listed recommendations are named as the results page names them: Manual, Not assessed and Not covered.
    expect(preview?.textContent).toContain("Manual recommendations and recommendations marked Not assessed or Not covered by the benchmark pack, listed with their CIS text for a manual check.")
    // Plain words: no dashes used as punctuation anywhere in the preview.
    expect(preview?.textContent).not.toMatch(/[\u2013\u2014]/)
    expect(preview?.textContent).not.toContain(" - ")
    expect(previewActions(preview!)).toEqual(["Start 30 day free trial", "Add a license key", "View sample report"])
    // Add a license key is a link to the License page, so it is announced as a destination.
    expect(preview?.querySelector('a[href="/license"]')?.textContent).toBe("Add a license key")
    // The certification is stated once on the page: in the preview.
    expect(container.querySelectorAll('[aria-label="CIS certification"]')).toHaveLength(1)
    // CIS Controls is not offered, so the CIS Benchmarks prompt never promises it.
    expect(preview?.textContent).not.toContain("CIS Controls")
    expect(container.textContent).not.toContain("Coming soon")
    expect(container.textContent).not.toContain("Refresh available benchmarks")
    expect(container.querySelector("#cis-delivered-title")?.textContent).toBe("1. Load benchmark")
    // No catalog, pack or recommendation list is requested for Community, and no pack is saved.
    expect(actions(fetch).filter((action) => /^cis-(catalog|fetch|list)/.test(action))).toEqual([])
    for (const [, init] of fetch.mock.calls) {
      const body = JSON.parse(String((init as RequestInit).body)) as { action: string; policies?: unknown[] }
      if (body.action === "workspace-save") expect(body.policies).toEqual([])
    }
    vi.unstubAllGlobals()
  })

  it("opens the plans and the License page from the Community preview", async () => {
    const { container } = communityPage()
    await flush()
    const preview = container.querySelector('[aria-label="CIS Benchmarks assessments, remediation and reports preview"]')!
    const button = (label: string) => [...preview.querySelectorAll<HTMLElement>("button, a")].find((item) => item.textContent === label)!
    const { bridge } = await import("../../src/renderer/lib/bridge")
    const open = vi.spyOn(bridge.license, "open")
    await act(async () => { button("Start 30 day free trial").click() })
    expect(open).toHaveBeenCalledWith("buy", { source: "cis-preview" })
    // Add a license key leaves the CIS page for the License page.
    await act(async () => { button("Add a license key").click() })
    await flush()
    expect(container.querySelector('[aria-label="CIS Benchmarks assessments, remediation and reports preview"]')).toBeNull()
    vi.unstubAllGlobals()
  })

  it("offers See plans instead of the trial when a license key is on this machine", async () => {
    const { container } = communityPage({ ...communityStatus(), hasKey: true, keyState: "failed" })
    await flush()
    const preview = container.querySelector('[aria-label="CIS Benchmarks assessments, remediation and reports preview"]')!
    expect(previewActions(preview)).toEqual(["See plans", "Add a license key", "View sample report"])
    vi.unstubAllGlobals()
  })

  it("saves the sample report on Community through the Save dialog in main, with no CIS content request", async () => {
    Element.prototype.scrollIntoView = () => undefined
    const { container, fetch } = communityPage()
    await flush()
    const preview = container.querySelector('[aria-label="CIS Benchmarks assessments, remediation and reports preview"]')!
    const sample = [...preview.querySelectorAll("button")].find((item) => item.textContent === "View sample report")!
    const before = fetch.mock.calls.length
    await act(async () => { sample.click() })
    await flush()
    const sent = fetch.mock.calls.slice(before).map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
    // One request: the sample, built in main from synthetic data and saved there. No tenant, pack or list.
    expect(sent).toEqual([{ action: "cis-sample-pdf", save: "dialog" }])
    expect(preview.textContent).toContain("TenuVault sample CIS readiness report (sample data).pdf")
    expect(actions(fetch).filter((action) => /^cis-(catalog|fetch|list)/.test(action))).toEqual([])
    vi.unstubAllGlobals()
  })

  const PREVIEW = '[aria-label="CIS Benchmarks assessments, remediation and reports preview"]'
  const CIS_CONTENT_ACTION = /^cis-(catalog|fetch|list|pack|content)/

  /** Clicks View sample report and returns every request body sent from then on. */
  async function requestSample(container: HTMLDivElement, fetch: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>[]> {
    Element.prototype.scrollIntoView = () => undefined
    const sample = [...container.querySelector(PREVIEW)!.querySelectorAll("button")].find((item) => item.textContent === "View sample report")!
    const before = fetch.mock.calls.length
    await act(async () => { sample.click() })
    await flush()
    return fetch.mock.calls.slice(before).map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
  }

  /** The setup stage shows no benchmark picker, and no catalog, pack or list was requested. */
  function expectNoCisContent(container: HTMLDivElement, fetch: ReturnType<typeof vi.fn>) {
    expect(container.querySelector("#cis-delivered-title")?.textContent).toBe("1. Load benchmark")
    expect(container.textContent).not.toContain("Refresh available benchmarks")
    expect(container.textContent).not.toContain("benchmarks available")
    expect(container.querySelector('[aria-label="Available benchmarks"]')).toBeNull()
    expect(actions(fetch).filter((action) => CIS_CONTENT_ACTION.test(action))).toEqual([])
  }

  function sampleFetch(workspaceFor?: string) {
    return vi.fn(async (_path: string, init?: RequestInit) => {
      const body = String(init?.body)
      if (body.includes("cis-sample-pdf")) return Response.json({ name: "TenuVault sample CIS readiness report (sample data).pdf", saved: true, path: "/Users/admin/Documents/TenuVault sample CIS readiness report (sample data).pdf" })
      const workspace = { version: 1, tenantId: workspaceFor ?? "", frameworkId: "cis-benchmarks", policies: [], reference: "", updatedAt: "", history: [] }
      return Response.json(body.includes("workspace-open") ? { workspace, activeJob: null } : workspace)
    })
  }

  it("shows the preview with no tenant selected, as on a fresh install, and sends no CIS content request", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = { ...communityStatus(), communityTenantId: null, tenants: [] }
    selectedTenantState.current = null
    const fetch = sampleFetch()
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    const preview = container.querySelector(PREVIEW)
    expect(preview).not.toBeNull()
    expect(previewActions(preview!)).toEqual(["Start 30 day free trial", "Add a license key", "View sample report"])
    expect(container.querySelectorAll('[aria-label="CIS certification"]')).toHaveLength(1)
    expectNoCisContent(container, fetch)
    // The sample names no tenant: the one request carries only the action.
    expect(await requestSample(container, fetch)).toEqual([{ action: "cis-sample-pdf", save: "dialog" }])
    expect(preview?.textContent).toContain("TenuVault sample CIS readiness report (sample data).pdf")
    expectNoCisContent(container, fetch)
    vi.unstubAllGlobals()
  })

  const SIGN_IN_LINE = "Sign in to Not signed in from the sidebar to load benchmarks and run an assessment."
  const SELECT_LINE = "Select a tenant in the sidebar and sign in to load benchmarks and run an assessment."

  it("asks a machine with a Pro key and no tenant selected to choose a tenant, never the upsell or the picker", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = entitledStatus("pro")
    selectedTenantState.current = null
    const fetch = sampleFetch()
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    expect(container.querySelector(PREVIEW)).toBeNull()
    expect(container.textContent).not.toContain("See plans")
    expect(container.textContent).not.toContain("Add a license key")
    expect(container.textContent).toContain(SELECT_LINE)
    expect(container.querySelectorAll('[aria-label="CIS certification"]')).toHaveLength(1)
    expectNoCisContent(container, fetch)
    vi.unstubAllGlobals()
  })

  it("asks a machine with a Pro key to sign in to the selected tenant, with no preview and no CIS content request", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = entitledStatus("pro")
    selectedTenantState.current = { id: 3, name: "Not signed in", credentials: undefined }
    const fetch = sampleFetch()
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    expect(container.querySelector(PREVIEW)).toBeNull()
    expect(container.textContent).not.toContain("See plans")
    expect(container.textContent).toContain(SIGN_IN_LINE)
    expect(container.textContent).not.toContain("Checking the plan")
    expect(container.querySelectorAll('[aria-label="CIS certification"]')).toHaveLength(1)
    expectNoCisContent(container, fetch)
    vi.unstubAllGlobals()
  })

  it("asks a machine with a Pro key to sign in to a saved profile with a lapsed activation, never the preview", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = { ...entitledStatus("pro"), tenants: [{ ...keyTenant("t-lapsed", "pro", 2), signedIn: false, entitled: false }] }
    signedInIds.current = new Set()
    selectedTenantState.current = { id: 3, name: "Not signed in", credentials: { tenantId: "t-lapsed", appId: "app-1", clientSecret: "" } }
    const fetch = sampleFetch()
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    expect(container.querySelector(PREVIEW)).toBeNull()
    expect(container.textContent).toContain(SIGN_IN_LINE)
    expect(container.textContent).not.toContain("Checking the plan")
    expectNoCisContent(container, fetch)
    vi.unstubAllGlobals()
  })

  it("shows the preview to a Community machine with a selected tenant that is not signed in", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = communityStatus()
    selectedTenantState.current = { id: 3, name: "Not signed in", credentials: undefined }
    const fetch = sampleFetch()
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    expect(previewActions(container.querySelector(PREVIEW)!)).toEqual(["Start 30 day free trial", "Add a license key", "View sample report"])
    expect(container.textContent).not.toContain(SIGN_IN_LINE)
    expectNoCisContent(container, fetch)
    vi.unstubAllGlobals()
  })

  it("waits for the plan of a signed-in tenant the license status does not list yet, with no preview and no request", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = { ...entitledStatus("pro"), tenants: [] }
    signedInIds.current = new Set(["t-entitled"])
    selectedTenantState.current = tenantRef("t-entitled")
    const fetch = sampleFetch("t-entitled")
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    expect(container.querySelector(PREVIEW)).toBeNull()
    expect(container.textContent).toContain("Checking the plan of the selected tenant")
    expect(container.textContent).not.toContain("See plans")
    expect(container.textContent).not.toContain("Sign in to")
    expect(container.querySelectorAll('[aria-label="CIS certification"]')).toHaveLength(1)
    expectNoCisContent(container, fetch)
    vi.unstubAllGlobals()
  })

  it("shows the preview to a tenant whose plan cannot be used, without the catalog it loaded earlier", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    // A lapsed Pro tenant: activated, but its entitlement is no longer valid, so its plan is null.
    licenseStatus.current = { ...entitledStatus("pro"), tenants: [{ ...keyTenant("t-entitled", "pro", 2), entitled: false }] }
    selectedTenantState.current = tenantRef("t-entitled")
    const { rememberCisCatalog, forgetCisCatalog } = await import("../../src/renderer/lib/cis-catalog-cache")
    rememberCisCatalog("t-entitled", [{ id: "synthetic-os", name: "Synthetic cached benchmark", version: "9.9.9", levels: [1] }] as never)
    const fetch = sampleFetch("t-entitled")
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    expect(container.querySelector(PREVIEW)).not.toBeNull()
    expect(container.textContent).not.toContain("Synthetic cached benchmark")
    expectNoCisContent(container, fetch)
    expect(await requestSample(container, fetch)).toEqual([{ action: "cis-sample-pdf", save: "dialog" }])
    expectNoCisContent(container, fetch)
    forgetCisCatalog("t-entitled")
    vi.unstubAllGlobals()
  })

  it("shows neither the preview nor the picker while the license loads, then the picker for Pro", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = null
    selectedTenantState.current = tenantRef("t-entitled")
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = String(init?.body)
      if (body.includes("cis-catalog")) return Response.json({ benchmarks: [] })
      const workspace = { version: 1, tenantId: "t-entitled", frameworkId: "cis-benchmarks", policies: [], reference: "", updatedAt: "", history: [] }
      return Response.json(body.includes("workspace-open") ? { workspace, activeJob: null } : workspace)
    })
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    expect(container.querySelector(PREVIEW)).toBeNull()
    expect(container.textContent).toContain("Checking the plan of the selected tenant")
    expectNoCisContent(container, fetch)
    licenseStatus.current = entitledStatus("pro")
    const root = roots[roots.length - 1]
    await act(async () => { root?.render(createElement(MemoryRouter, { initialEntries: ["/portal/frameworks/cis-benchmarks"] }, createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) })))) })
    await flush()
    expect(container.querySelector(PREVIEW)).toBeNull()
    expect(container.textContent).toContain("Refresh available benchmarks")
    expect(actions(fetch)).toContain("cis-catalog")
    vi.unstubAllGlobals()
  })

  it("does not show the preview while saved assessments load", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = communityStatus()
    selectedTenantState.current = tenantRef("t-community")
    let openWorkspace: (response: Response) => void = () => undefined
    const workspace = { version: 1, tenantId: "t-community", frameworkId: "cis-benchmarks", policies: [], reference: "", updatedAt: "", history: [] }
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => String(init?.body).includes("workspace-open")
      ? new Promise<Response>((resolve) => { openWorkspace = resolve })
      : Response.json(workspace))
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    expect(container.textContent).toContain("Loading saved assessments")
    expect(container.querySelector(PREVIEW)).toBeNull()
    expect(container.querySelectorAll('[aria-label="CIS certification"]')).toHaveLength(1)
    await act(async () => { openWorkspace(Response.json({ workspace, activeJob: null })) })
    await flush()
    expect(container.querySelector(PREVIEW)).not.toBeNull()
    expect(container.querySelectorAll('[aria-label="CIS certification"]')).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it("shows Pro the benchmark picker and the certification note, never the preview", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = entitledStatus("pro")
    selectedTenantState.current = tenantRef("t-entitled")
    const workspace = { version: 1, tenantId: "t-entitled", frameworkId: "cis-benchmarks", policies: [], reference: "", updatedAt: "", history: [] }
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = String(init?.body)
      if (body.includes("cis-catalog")) return Response.json({ benchmarks: [] })
      return Response.json(body.includes("workspace-open") ? { workspace, activeJob: null } : workspace)
    })
    vi.stubGlobal("fetch", fetch)
    const container = renderCisRoute()
    await flush()
    expect(container.querySelector('[aria-label="CIS Benchmarks assessments, remediation and reports preview"]')).toBeNull()
    expect(container.textContent).not.toContain("View sample report")
    expect(container.textContent).toContain("Refresh available benchmarks")
    const note = container.querySelector('[aria-label="CIS certification"]')
    expect(note?.textContent).toContain(CIS_CERTIFICATION_HEADLINE)
    for (const line of certifiedScopeLines()) expect(note?.textContent).toContain(line)
    vi.unstubAllGlobals()
  })

  it("marks certified Levels in the benchmark picker and names uncertified ones", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    licenseStatus.current = entitledStatus("pro")
    selectedTenantState.current = tenantRef("t-entitled")
    const benchmarks = [
      { id: "intune-windows11", name: "Synthetic Windows name", version: "5.0.0", levels: [1, 2] },
      { id: "mac-os-26", name: "Synthetic macOS name", version: "1.0.0", levels: [1, 2] },
      { id: "fakebook-os", name: "Fakebook OS", version: "9.9.9", levels: [1] },
    ]
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      const body = String(init?.body)
      if (body.includes("cis-catalog")) return Response.json({ benchmarks })
      if (body.includes("workspace-open")) return Response.json({ workspace: { version: 1, tenantId: "t-entitled", frameworkId: "cis-benchmarks", policies: [], reference: "", updatedAt: "", history: [] }, activeJob: null })
      return Response.json({ version: 1, tenantId: "t-entitled", frameworkId: "cis-benchmarks", policies: [], reference: "", updatedAt: "", history: [] })
    }))
    const container = renderCisRoute()
    await flush()
    await flush()
    const marks = (name: string) => [...(container.querySelector(`[aria-label="Certification of ${name}"]`)?.querySelectorAll("li") ?? [])].map((item) => item.textContent)
    expect(marks("Synthetic Windows name")).toEqual(["Level 1: CIS Certified", "Level 2: Not certified"])
    expect(marks("Synthetic macOS name")).toEqual(["Level 1: CIS Certified", "Level 2: CIS Certified"])
    expect(marks("Fakebook OS")).toEqual(["Level 1: Not certified"])
    vi.unstubAllGlobals()
  })

  it("marks the results and each saved assessment CIS Certified or Not certified by benchmark, version and Level", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    const tenantId = "11111111-1111-1111-1111-111111111111"
    licenseStatus.current = { ...entitledStatus("pro"), tenants: [keyTenant(tenantId, "pro", 2)] }
    selectedTenantState.current = { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId: "22222222-2222-2222-2222-222222222222" } }
    const policyFor = (level: number) => ({ name: `Synthetic Level ${level} policy`, platforms: "windows10", technologies: "mdm", description: "Synthetic",
      provenance: { schemaVersion: 1, benchmark: "intune-windows11", version: "5.0.0", level: `Level ${level}`, benchmarkName: "Microsoft Intune for Windows 11" },
      settings: [{ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: "synthetic_setting", choiceSettingValue: { value: "synthetic_on", children: [] } } }] })
    const entry = (level: number, assessedAt: string) => {
      const policy = policyFor(level)
      return { policies: [policy], assessment: { runId: `run-${level}`, tenantId, frameworkId: "cis-benchmarks", reference: `intune-windows11 5.0.0 Level ${level}`, assessedAt, policyCount: 1,
        findings: [{ key: "0:0", policyIndex: 0, settingIndex: 0, policyName: policy.name, settingId: "synthetic_setting", status: "Missing", recommended: policy.settings[0]!.settingInstance, observed: [] }] } }
    }
    const history = [entry(1, "2026-11-02T10:00:00Z"), entry(2, "2026-11-01T10:00:00Z")]
    const workspace = { version: 1, tenantId, frameworkId: "cis-benchmarks", policies: history[0]!.policies, reference: history[0]!.assessment.reference, updatedAt: "2026-11-02T10:00:00Z", history }
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const body = String(init?.body)
      if (path !== "/api/frameworks") return Response.json({ deployments: [] })
      if (body.includes("cis-catalog")) return Response.json({ benchmarks: [] })
      return Response.json(body.includes('"workspace-open"') ? { workspace, activeJob: null } : workspace)
    }))
    const container = renderCisRoute()
    await flush()
    const header = () => container.querySelector('[aria-label="Results header"]')?.textContent ?? ""
    expect(header()).toContain("Microsoft Intune for Windows 11 5.0.0 Level 1CIS Certified")
    const rows = () => [...container.querySelectorAll('[aria-label="Saved assessment history"] .border-t')].map((row) => row.textContent ?? "")
    expect(rows()).toHaveLength(2)
    expect(rows()[0]).toMatch(/^CIS Certified/)
    expect(rows()[1]).toMatch(/^Not certified/)
    const views = [...container.querySelectorAll("button")].filter((item) => item.textContent === "View read-only")
    await act(async () => { views[1]!.click() })
    await flush()
    expect(header()).toContain("Microsoft Intune for Windows 11 5.0.0 Level 2Not certified")
    expect(header()).not.toContain("CIS Certified")
    vi.unstubAllGlobals()
  })

  async function renderSavedAssessment(extra: object = {}, findingExtra: (policy: { settings: Array<{ settingInstance: object }> }) => object = () => ({})): Promise<HTMLDivElement> {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const tenantId = "11111111-1111-1111-1111-111111111111"
    selectedTenantState.current = { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId: "22222222-2222-2222-2222-222222222222" } }
    const policy = { name: "Synthetic policy", platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark: "synthetic-os", version: "9.9.9", level: "Level 1", sourceFile: "synthetic.json" },
      settings: [{ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: "synthetic_setting", choiceSettingValue: { value: "synthetic_on", children: [] } } }], ...extra }
    const assessment = { runId: "run-1", tenantId, frameworkId: "cis-benchmarks", reference: "synthetic-os 9.9.9 Level 1", assessedAt: "2026-10-15T10:00:00Z", policyCount: 1,
      findings: [{ key: "0:0", policyIndex: 0, settingIndex: 0, policyName: "Synthetic policy", settingId: "synthetic_setting", status: "Missing", recommended: policy.settings[0]!.settingInstance, observed: [], ...findingExtra(policy) }] }
    const workspace = { version: 1, tenantId, frameworkId: "cis-benchmarks", policies: [policy], reference: assessment.reference, updatedAt: "2026-10-15T10:00:00Z", history: [{ assessment, policies: [policy] }] }
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const opening = path === "/api/frameworks" && String(init?.body).includes('"workspace-open"')
      return new Response(JSON.stringify(path === "/api/cis-remediation" ? { deployments: [] } : opening ? { workspace, activeJob: null } : workspace), { status: 200, headers: { "Content-Type": "application/json" } })
    }))
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

  it("keeps saved results readable on Community but gates the readiness CSV and JSON and Run again", async () => {
    licenseStatus.current = { ...communityStatus(), communityTenantId: "11111111-1111-1111-1111-111111111111", tenants: [communityTenant("11111111-1111-1111-1111-111111111111")] }
    const container = await renderSavedAssessment()
    // The saved readiness stays on screen.
    expect(container.querySelector('[aria-label="CIS readiness"]')).not.toBeNull()
    // The Export menu renders its items in a portal once it opens.
    const exportTrigger = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Export")!
    await act(async () => { exportTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    await flush()
    const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    for (const label of ["Readiness CSV", "Readiness JSON", "Findings CSV", "Findings JSON", "PDF report"]) {
      const option = menuItems().find((item) => item.textContent?.startsWith(label))
      expect(option, label).toBeDefined()
      // Visible with the plan badge, and choosing it explains the plan instead of exporting.
      expect(option?.hasAttribute("data-disabled"), label).toBe(false)
      expect(option?.getAttribute("title"), label).toContain("CIS Benchmarks assessments, remediation and reports")
    }
    const readinessCsv = menuItems().find((item) => item.textContent?.startsWith("Readiness CSV"))!
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const before = fetchMock.mock.calls.length
    await act(async () => { readinessCsv.click() })
    await flush()
    // The click explains the plan; nothing is exported or sent.
    expect(document.body.textContent).toContain("Included in TenuVault Pro and MSP")
    expect(fetchMock.mock.calls.length).toBe(before)
    // Closing the plan dialog returns focus to the Export button.
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
    await flush()
    expect(document.body.textContent).not.toContain("Included in TenuVault Pro and MSP")
    expect(document.activeElement).toBe(exportTrigger)
    const runAgain = [...container.querySelectorAll("button")].find((item) => item.textContent === "Run again")
    expect(runAgain?.disabled).toBe(true)
    expect(container.textContent).toContain("Saved results stay readable.")
    // The saved results show without the preview; it shows where a new assessment would start.
    const preview = '[aria-label="CIS Benchmarks assessments, remediation and reports preview"]'
    expect(container.querySelector(preview)).toBeNull()
    expect(container.querySelector('[aria-label="CIS certification"]')).not.toBeNull()
    const newAssessment = [...container.querySelectorAll("button")].find((item) => item.textContent === "New assessment")!
    await act(async () => { newAssessment.click() })
    await flush()
    expect(container.querySelector(preview)).not.toBeNull()
    expect(container.querySelectorAll('[aria-label="CIS certification"]')).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it("exports from the Export menu on Pro, with the menu in a portal outside the results cards", async () => {
    const tenantId = "11111111-1111-1111-1111-111111111111"
    licenseStatus.current = { ...entitledStatus("pro"), tenants: [keyTenant(tenantId, "pro", 2)] }
    const container = await renderSavedAssessment()
    const exportTrigger = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Export")!
    await act(async () => { exportTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    await flush()
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')
    expect(menu).not.toBeNull()
    // A card's stacking context cannot cover the menu: it is not rendered inside the page.
    expect(container.contains(menu)).toBe(false)
    const findingsCsv = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Findings CSV")!
    expect(findingsCsv.getAttribute("title")).toBeNull()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    await act(async () => { findingsCsv.click() })
    await flush()
    expect(fetchMock.mock.calls.some(([, init]) => String((init as RequestInit | undefined)?.body).includes('"workspace-csv"'))).toBe(true)
    expect(document.body.textContent).not.toContain("Included in TenuVault Pro and MSP")
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    vi.unstubAllGlobals()
  })

  it("keeps saved results and the remediation history of a lapsed tenant, with the preview only where a new assessment starts", async () => {
    const tenantId = "11111111-1111-1111-1111-111111111111"
    // Activated on Pro, but the entitlement lapsed: the plan resolves to null.
    licenseStatus.current = { ...entitledStatus("pro"), tenants: [{ ...keyTenant(tenantId, "pro", 2), entitled: false }] }
    const container = await renderSavedAssessment()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    expect(container.querySelector('[aria-label="CIS readiness"]')).not.toBeNull()
    expect(container.textContent).toContain("Saved results stay readable.")
    // The remediation history, where rollback starts, still loads for the tenant.
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/cis-remediation")).toBe(true)
    const preview = '[aria-label="CIS Benchmarks assessments, remediation and reports preview"]'
    expect(container.querySelector(preview)).toBeNull()
    await act(async () => { [...container.querySelectorAll("button")].find((item) => item.textContent === "New assessment")!.click() })
    await flush()
    expect(container.querySelector(preview)).not.toBeNull()
    expect(container.textContent).not.toContain("Refresh available benchmarks")
    expect(actions(fetchMock).filter((action) => /^cis-(catalog|fetch|list|pack|content)/.test(action))).toEqual([])
    vi.unstubAllGlobals()
  })

  it("says per recommendation whether TenuVault can remediate it", async () => {
    licenseStatus.current = { ...entitledStatus("pro"), tenants: [keyTenant("11111111-1111-1111-1111-111111111111", "pro", 2)] }
    const container = await renderSavedAssessment({ recommendations: [
      { id: "7.1.1", title: "Synthetic recommendation", level: 1, settings: ["synthetic_setting"] },
      { id: "7.1.2", title: "Synthetic partly mapped recommendation", level: 1, settings: ["synthetic_setting", "synthetic_unmapped"] },
    ] })
    const results = [...container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent?.startsWith("Recommendation results, Level 1"))
    expect(results).toBeDefined()
    const rows = [...results!.querySelectorAll("li")]
    expect(rows.find((row) => row.textContent?.includes("7.1.1"))?.textContent).toContain("Remediation: by TenuVault.")
    expect(rows.find((row) => row.textContent?.includes("7.1.2"))?.textContent).toContain("Remediation: partly by TenuVault, partly manual action.")
    vi.unstubAllGlobals()
  })

  it("shows the CIS manual notice with its link in the readiness view without a manual recommendation list", async () => {
    const openExternal = vi.fn(async () => undefined)
    const { bridge } = await import("../../src/renderer/lib/bridge")
    ;(bridge.app as unknown as { openExternal: typeof openExternal }).openExternal = openExternal
    const container = await renderSavedAssessment()
    const notice = container.querySelector('[aria-label="CIS readiness"] [role="note"]')
    expect(notice?.textContent).toContain("Not all recommendations from the CIS Benchmarks are included in this tool. Please refer to the CIS website to access the free CIS Benchmarks PDFs for manual assessment instructions.")
    // The notice is information, not an error: neutral colors, which the app does not remap to coral as it does blue.
    for (const element of [notice!, ...notice!.querySelectorAll("svg")]) expect(element.getAttribute("class")).not.toMatch(/blue|red|amber/)
    expect(notice?.className).toContain("bg-gray-50")
    const link = notice?.querySelector("a")
    expect(link?.textContent).toBe("https://www.cisecurity.org/cis-benchmarks")
    await act(async () => { link!.click() })
    expect(openExternal).toHaveBeenCalledWith("https://www.cisecurity.org/cis-benchmarks")
    expect(container.textContent).not.toContain("Recommendation results")
    // Without a recommendation list the settings pass rate leads and identifier coverage stays.
    const summary = container.querySelector('[aria-label="Level 1 summary"]')
    expect(summary?.textContent).toContain("Settings pass rate")
    expect(summary?.textContent).not.toContain("Recommendation pass rate")
    // Coverage of the full benchmark is stated in plain words; internal counters stay out of the view.
    expect(summary?.textContent).toContain("Coverage of the full benchmarkNot available")
    expect(summary?.textContent).toContain("Scored by settings because this benchmark has no recommendation mapping.")
    for (const hidden of ["Enumerated identifiers", "Assessed automated", "denominator"]) expect(container.textContent).not.toContain(hidden)
    expect(container.textContent).toContain("Coverage of the full benchmark is not shown because the list of all its automated recommendations is not available.")
    vi.unstubAllGlobals()
  })

  it("states the limits of remediation in the readiness view and in the Remediate panel", async () => {
    const container = await renderSavedAssessment()
    const readiness = container.querySelector('[aria-label="CIS readiness"]')
    expect(readiness?.querySelector('[aria-label="Limits of remediation"]')?.textContent).toContain(CIS_REMEDIATION_LIMITS[0]!)
    const panel = container.querySelector('section[aria-labelledby="cis-deploy-title"]')
    const limits = panel?.querySelector('[aria-label="Limits of remediation"]')
    for (const line of CIS_REMEDIATION_LIMITS) expect(limits?.textContent).toContain(line)
    vi.unstubAllGlobals()
  })

  it("shows the service refusal of the catalog in plain words", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    licenseStatus.current = entitledStatus("pro")
    selectedTenantState.current = tenantRef("t-entitled")
    const workspace = { version: 1, tenantId: "t-entitled", frameworkId: "cis-benchmarks", policies: [], reference: "", updatedAt: "", history: [] }
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      const body = String(init?.body)
      if (body.includes("cis-catalog")) return Response.json({ error: "CIS Benchmarks content is not available for this license yet." }, { status: 403 })
      return Response.json(body.includes("workspace-open") ? { workspace, activeJob: null } : workspace)
    }))
    const container = renderCisRoute()
    await flush()
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("CIS Benchmarks content is not available for this license yet.")
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

  it("shows Not available with a reason, not the settings rate, when no recommendation could be assessed", async () => {
    const container = await renderSavedAssessment({ recommendations: [{ id: "7.1.1", title: "Synthetic recommendation", level: 1, settings: ["synthetic_setting", "synthetic_unmapped"] }] },
      policy => ({ status: "Present", observed: [{ policyId: "33333333-3333-3333-3333-333333333333", policyName: "Tenant policy", value: policy.settings[0]!.settingInstance }] }))
    const summary = container.querySelector('[aria-label="Level 1 summary"]')
    expect(summary?.textContent).toContain("Not availableRecommendation pass rate")
    expect(summary?.textContent).toContain("No recommendation of this Level could be assessed")
    expect(summary?.textContent).toContain("Settings: 1 of 1 present")
    expect(summary?.textContent).not.toContain("100%")
    vi.unstubAllGlobals()
  })
})
