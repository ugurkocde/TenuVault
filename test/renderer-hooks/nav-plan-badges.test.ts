import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const licenseStatus = vi.hoisted(() => ({ current: null as unknown }))
// Tenants the account store has a sign-in for; undefined while it is not read yet.
const signedInIds = vi.hoisted(() => ({ current: new Set(["t-1"]) as ReadonlySet<string> | undefined }))
const selectedTenantState = vi.hoisted(() => ({ current: null as unknown }))
const routerPush = vi.hoisted(() => vi.fn())

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { info: async () => ({}) },
    license: { open: async () => undefined },
    preferences: { get: async () => ({}), set: async () => ({}) },
  },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: licenseStatus.current, signedInTenantIds: signedInIds.current, error: null, refresh: async () => undefined }),
}))
vi.mock("~/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: selectedTenantState.current, selectedTenantId: null, setSelectedTenantId: () => undefined }),
  useTenants: () => [],
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))
// The sidebar's other parts, which these tests do not look at.
vi.mock("~/components/backup/floating-progress", () => ({ FloatingProgress: () => null }))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined, Toaster: () => null }))
vi.mock("../../src/renderer/lib/framework-jobs", () => ({ useFrameworkJobs: () => [], FrameworkJobNotifier: () => null }))
vi.mock("../../src/renderer/lib/cis-jobs", () => ({ CisJobNotifier: () => null }))
vi.mock("../../src/renderer/lib/drift-jobs", () => ({ DriftScanIndicator: () => null, DriftScanNotifier: () => null }))
vi.mock("../../src/renderer/features/scores/invalidate", () => ({ useScoreInvalidation: () => undefined }))
vi.mock("../../src/renderer/lib/whats-new", () => ({ useWhatsNew: () => ({ state: null }) }))
vi.mock("../../src/renderer/components/BackgroundTasksPanel", () => ({ BackgroundTasksPanel: () => null }))
vi.mock("../../src/renderer/components/SignInBanner", () => ({ SignInBanner: () => null }))
vi.mock("../../src/renderer/components/SupportDialog", () => ({ SupportDialog: () => null }))
vi.mock("../../src/renderer/components/TenantSwitcher", () => ({ TenantSwitcher: () => null }))
vi.mock("../../src/renderer/components/UpdateSidebarLabel", () => ({ UpdateSidebarLabel: () => null }))
vi.mock("../../src/renderer/components/WhatsNewDialog", () => ({ WhatsNewAnnouncement: () => null, WhatsNewDialog: () => null }))
vi.mock("../../src/renderer/components/TenantAccessNotice", () => ({ TenantAccessNotice: () => null }))
vi.mock("../../src/renderer/components/oib/JobIndicator", () => ({ OibJobIndicator: () => null, OibJobCard: () => null }))
vi.mock("../../src/renderer/features/custom-baselines/api", () => ({ customizeOib: vi.fn() }))
vi.mock("../../src/renderer/lib/appearance", () => ({ getAppearance: () => "light", setAppearance: () => undefined }))

import { DesktopLayout } from "../../src/renderer/components/DesktopLayout"
import { FrameworkNavigation } from "../../src/renderer/components/FrameworkNavigation"
import { CustomizeCard } from "../../src/renderer/pages/OibPage"
import { SettingsSectionNav } from "../../src/renderer/pages/SettingsPage"
import { ViewAllActivityButton } from "../../src/portal/app/portal/dashboard/page"
import { NAV_PLAN_FEATURES } from "../../src/renderer/components/NavPlanBadge"
import { HUBS } from "../../src/renderer/features/hubs"

const roots: Root[] = []

async function render(element: ReturnType<typeof createElement>, route = "/portal/dashboard"): Promise<HTMLDivElement> {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [route] }, element)))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  licenseStatus.current = null
  signedInIds.current = new Set(["t-1"])
  selectedTenantState.current = null
  vi.clearAllMocks()
})

function tenantEntry(tenantId: string, plan: "community" | "pro" | "msp", signedIn = true) {
  const paid = plan !== "community"
  return { tenantId, signedIn, activated: paid, entitled: paid, source: paid ? "key" : null, plan, tenants: paid ? 2 : null, expiresAt: paid ? "2030-01-01T00:00:00.000Z" : null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }
}

function statusFor(plan: "community" | "pro" | "msp") {
  const paid = plan !== "community"
  return { hasKey: paid, keyState: paid ? "active" : "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: paid ? plan : null, tenantLimit: paid ? 2 : null, validUntil: null, communityTenantId: paid ? null : "t-1", tenants: [tenantEntry("t-1", plan)] }
}

function selectTenant() {
  selectedTenantState.current = { id: 1, name: "Contoso", credentials: { tenantId: "t-1", appId: "app-1", clientSecret: "" } }
}

const PAID_ENTRIES = [["Audit Log", "/portal/audit"], ["Governance", "/portal/governance"], ["Changes", "/portal/changes"], ["Operations", "/portal/operations"]] as const

function sidebarLink(container: HTMLElement, href: string): HTMLAnchorElement {
  return container.querySelector<HTMLAnchorElement>(`nav[aria-label="Main navigation"] a[href="${href}"]`)!
}

describe("sidebar plan badges for paid screens", () => {
  it("badges each hub by all of its tabs and the audit log by its feature", () => {
    expect(NAV_PLAN_FEATURES["/portal/audit"]).toEqual(["auditLog"])
    for (const hub of HUBS) expect(NAV_PLAN_FEATURES[`/portal/${hub.id}`]).toEqual(hub.tabs.map((tab) => tab.feature))
    expect(Object.keys(NAV_PLAN_FEATURES).sort()).toEqual(["/portal/audit", "/portal/changes", "/portal/governance", "/portal/operations"])
  })

  it("marks Audit Log, Governance, Changes and Operations with Pro for Community and keeps them links", async () => {
    licenseStatus.current = statusFor("community")
    selectTenant()
    const container = await render(createElement(DesktopLayout))
    for (const [name, href] of PAID_ENTRIES) {
      const link = sidebarLink(container, href)
      expect(link, name).not.toBeNull()
      expect(link.tagName).toBe("A")
      expect(link.getAttribute("aria-disabled")).toBeNull()
      expect(link.textContent).toBe(`${name}Pro`)
    }
    // Screens Community has carry no badge.
    for (const href of ["/portal/dashboard", "/portal/tenants", "/portal/backup", "/portal/drift", "/portal/oib"]) expect(sidebarLink(container, href).textContent).not.toMatch(/Pro$|MSP$/)
  })

  it("shows no badge on Pro or MSP, where every one of those screens is included", async () => {
    for (const plan of ["pro", "msp"] as const) {
      licenseStatus.current = statusFor(plan)
      selectTenant()
      const container = await render(createElement(DesktopLayout))
      for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(container, href).textContent, `${plan} ${name}`).toBe(name)
      document.body.replaceChildren()
    }
  })

  it("shows no badge while the plan is pending", async () => {
    licenseStatus.current = null
    selectTenant()
    const loading = await render(createElement(DesktopLayout))
    for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(loading, href).textContent).toBe(name)
    // A signed-in tenant the license status does not list yet is pending too.
    licenseStatus.current = { ...statusFor("pro"), tenants: [] }
    const unlisted = await render(createElement(DesktopLayout))
    for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(unlisted, href).textContent).toBe(name)
    // So is a tenant the status lists as not signed in while the account store has its sign-in.
    licenseStatus.current = { ...statusFor("msp"), tenants: [{ ...tenantEntry("t-1", "msp", false), entitled: false }] }
    const catchingUp = await render(createElement(DesktopLayout))
    for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(catchingUp, href).textContent).toBe(name)
    // And a tenant the status does not list as signed in, before the account store is read.
    signedInIds.current = undefined
    licenseStatus.current = { ...statusFor("community"), tenants: [] }
    const unread = await render(createElement(DesktopLayout))
    for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(unread, href).textContent).toBe(name)
    expect(sidebarLink(unread, "/portal/frameworks/cis-benchmarks").textContent).toBe("CIS Benchmarks")
  })

  describe("a saved tenant profile that is not signed in", () => {
    // The profile keeps its credentials after a sign-out; the account store has no sign-in for it.
    const notSignedIn = () => {
      signedInIds.current = new Set()
      selectTenant()
    }

    it("uses the MSP machine plan, not the lapsed activation the status lists for it: no badge", async () => {
      notSignedIn()
      licenseStatus.current = { ...statusFor("msp"), tenants: [{ ...tenantEntry("t-1", "msp", false), entitled: false }] }
      const container = await render(createElement(DesktopLayout))
      for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(container, href).textContent).toBe(name)
      expect(sidebarLink(container, "/portal/frameworks/cis-benchmarks").textContent).toBe("CIS Benchmarks")
    })

    it("uses the machine plan when the status does not list it", async () => {
      notSignedIn()
      licenseStatus.current = { ...statusFor("msp"), tenants: [] }
      const msp = await render(createElement(DesktopLayout))
      for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(msp, href).textContent).toBe(name)
      document.body.replaceChildren()
      licenseStatus.current = { ...statusFor("community"), tenants: [] }
      const community = await render(createElement(DesktopLayout))
      for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(community, href).textContent).toBe(`${name}Pro`)
      expect(sidebarLink(community, "/portal/frameworks/cis-benchmarks").textContent).toBe("CIS BenchmarksPro")
    })

    it("uses the Community machine plan over a paid activation the status lists for it", async () => {
      notSignedIn()
      licenseStatus.current = { ...statusFor("community"), tenants: [tenantEntry("t-1", "pro", false)] }
      const container = await render(createElement(DesktopLayout))
      for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(container, href).textContent).toBe(`${name}Pro`)
    })
  })

  it("marks a signed-in tenant whose activation lapsed on an MSP machine, since its own plan applies", async () => {
    selectTenant()
    licenseStatus.current = { ...statusFor("msp"), tenants: [{ ...tenantEntry("t-1", "msp"), entitled: false }] }
    const container = await render(createElement(DesktopLayout))
    for (const [name, href] of PAID_ENTRIES) expect(sidebarLink(container, href).textContent).toBe(`${name}Pro`)
    expect(sidebarLink(container, "/portal/frameworks/cis-benchmarks").textContent).toBe("CIS BenchmarksPro")
  })

  it("marks My baselines with Pro for Community only, still as a link", async () => {
    const myBaselines = async () => {
      const container = await render(createElement(FrameworkNavigation), "/portal/baselines")
      return container.querySelector<HTMLAnchorElement>('a[href="/portal/baselines"]')!
    }
    licenseStatus.current = statusFor("community")
    selectTenant()
    expect((await myBaselines()).textContent).toBe("My baselinesPro")
    licenseStatus.current = statusFor("pro")
    expect((await myBaselines()).textContent).toBe("My baselines")
    licenseStatus.current = statusFor("msp")
    expect((await myBaselines()).textContent).toBe("My baselines")
    licenseStatus.current = null
    expect((await myBaselines()).textContent).toBe("My baselines")
  })
})

describe("My baselines on the OpenIntuneBaseline page", () => {
  const link = async () => {
    const container = await render(createElement(CustomizeCard, { selections: null, versions: null }), "/portal/oib")
    // The button next to Customize; the description also links My baselines in its text.
    return [...container.querySelectorAll<HTMLAnchorElement>('a[href="/portal/baselines"]')].at(-1)!
  }

  it("carries the Pro badge for Community and none on Pro, MSP or while pending", async () => {
    selectTenant()
    licenseStatus.current = statusFor("community")
    expect((await link()).textContent).toBe("My baselinesPro")
    licenseStatus.current = statusFor("pro")
    expect((await link()).textContent).toBe("My baselines")
    licenseStatus.current = statusFor("msp")
    expect((await link()).textContent).toBe("My baselines")
    licenseStatus.current = null
    expect((await link()).textContent).toBe("My baselines")
  })
})

describe("Settings section list", () => {
  const rows = async () => {
    const container = await render(createElement(SettingsSectionNav, { section: "signin" }), "/portal/settings")
    return Object.fromEntries([...container.querySelectorAll('nav[aria-label="Settings sections"] a')].map((link): [string, string] => [link.getAttribute("href") ?? "", link.textContent ?? ""]))
  }

  it("marks Notifications and PDF branding with Pro for Community and keeps every section a link", async () => {
    licenseStatus.current = statusFor("community")
    const community = await rows()
    expect(Object.keys(community)).toHaveLength(8)
    expect(Object.values(community).filter((text) => text?.endsWith("Pro"))).toEqual(["NotificationsPro", "PDF brandingPro"])
  })

  it("shows no badge on Pro, MSP or while the license status loads", async () => {
    for (const status of [statusFor("pro"), statusFor("msp"), null]) {
      licenseStatus.current = status
      expect(Object.values(await rows()).some((text) => text?.endsWith("Pro"))).toBe(false)
      document.body.replaceChildren()
    }
  })

  it("shows no badge before the account store is read", async () => {
    licenseStatus.current = statusFor("community")
    signedInIds.current = undefined
    expect(Object.values(await rows()).some((text) => text?.endsWith("Pro"))).toBe(false)
  })

  it("never flashes the badge while a paid tenant just signed in to is not listed yet", async () => {
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    roots.push(root)
    // A new element each time, so the mocked license value is read again as after a context change.
    const badges = async () => {
      act(() => root.render(createElement(MemoryRouter, { initialEntries: ["/portal/settings"] }, createElement(SettingsSectionNav, { section: "signin" }))))
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      return [...container.querySelectorAll('nav[aria-label="Settings sections"] a')].map((link) => link.textContent ?? "").filter((text) => text.endsWith("Pro"))
    }
    // Community before the sign-in: the badges show.
    licenseStatus.current = statusFor("community")
    expect(await badges()).toEqual(["NotificationsPro", "PDF brandingPro"])
    // Signed in to t-2, which the status does not list yet, then lists as not signed in yet.
    signedInIds.current = new Set(["t-1", "t-2"])
    expect(await badges()).toEqual([])
    licenseStatus.current = { ...statusFor("community"), tenants: [tenantEntry("t-1", "community"), { ...tenantEntry("t-2", "pro", false), entitled: false }] }
    expect(await badges()).toEqual([])
    // The status catches up with t-2 on Pro: still no badge.
    licenseStatus.current = { ...statusFor("community"), tenants: [tenantEntry("t-1", "community"), tenantEntry("t-2", "pro")] }
    expect(await badges()).toEqual([])
  })

  it("shows the badges again once a tenant just signed in to is listed on Community", async () => {
    signedInIds.current = new Set(["t-1", "t-2"])
    licenseStatus.current = statusFor("community")
    expect(Object.values(await rows()).some((text) => text?.endsWith("Pro"))).toBe(false)
    document.body.replaceChildren()
    licenseStatus.current = { ...statusFor("community"), tenants: [tenantEntry("t-1", "community"), tenantEntry("t-2", "community")] }
    expect(Object.values(await rows()).filter((text) => text?.endsWith("Pro"))).toEqual(["NotificationsPro", "PDF brandingPro"])
  })
})

describe("View All Activity on the dashboard", () => {
  const button = async (plan: "community" | "pro" | "msp" | null) => {
    const container = await render(createElement(ViewAllActivityButton, { plan }))
    return container.querySelector("button")!
  }

  it("carries the Pro badge for Community and still opens the audit log", async () => {
    const community = await button("community")
    expect(community.textContent).toBe("View All ActivityPro")
    expect(community.disabled).toBe(false)
    act(() => community.click())
    expect(routerPush).toHaveBeenCalledWith("/portal/audit")
  })

  it("shows no badge on Pro, MSP or while the plan is not known", async () => {
    expect((await button("pro")).textContent).toBe("View All Activity")
    expect((await button("msp")).textContent).toBe("View All Activity")
    expect((await button(null)).textContent).toBe("View All Activity")
  })
})
