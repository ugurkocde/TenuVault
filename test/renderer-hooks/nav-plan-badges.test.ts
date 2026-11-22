import { readFileSync } from "node:fs"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useNavigate } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const licenseStatus = vi.hoisted(() => ({ current: null as unknown }))
// Tenants the account store has a sign-in for; undefined while it is not read yet.
const signedInIds = vi.hoisted(() => ({ current: new Set(["t-1"]) as ReadonlySet<string> | undefined }))
const selectedTenantState = vi.hoisted(() => ({ current: null as unknown }))
const routerPush = vi.hoisted(() => vi.fn())
const trialAction = vi.hoisted(() => vi.fn(async () => undefined))
const whatsNewState = vi.hoisted(() => ({ current: null as { hasUnseen: boolean } | null }))
const supportDialog = vi.hoisted(() => vi.fn((_props: { open: boolean; returnFocus?: { current: HTMLElement | null } }) => null))
const whatsNewDialog = vi.hoisted(() => vi.fn((_props: { open: boolean; returnFocus?: { current: HTMLElement | null } }) => null))
// Records whether the Help menu was still in the page when the window was captured.
const feedbackCapture = vi.hoisted(() => vi.fn(async (_page?: string) => { menuAtCapture.push(document.querySelector('[role="menu"]') !== null); return null }))
const menuAtCapture = vi.hoisted(() => [] as boolean[])
const discardCapture = vi.hoisted(() => vi.fn(async (_id: string) => undefined))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { info: async () => ({}) },
    auth: { accounts: async () => [] },
    schedules: { list: async () => [] },
    license: { open: async () => undefined, tenantTrialAction: trialAction },
    preferences: { get: async () => ({}), set: async () => ({}) },
    feedback: { capture: feedbackCapture, discardCapture },
  },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: licenseStatus.current, signedInTenantIds: signedInIds.current, error: null, refresh: async () => undefined }),
}))
vi.mock("~/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: selectedTenantState.current, selectedTenantId: null, setSelectedTenantId: () => undefined }),
  useTenants: () => [],
  useTenantOperations: () => ({ updateTenant: () => undefined }),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))
// The sidebar's other parts, which these tests do not look at.
vi.mock("~/components/backup/floating-progress", () => ({ FloatingProgress: () => null }))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined, Toaster: () => null }))
vi.mock("../../src/renderer/lib/framework-jobs", () => ({ useFrameworkJobs: () => [], FrameworkJobNotifier: () => null }))
vi.mock("../../src/renderer/lib/cis-jobs", () => ({ CisJobNotifier: () => null }))
vi.mock("../../src/renderer/lib/drift-jobs", () => ({ DriftScanIndicator: () => null, DriftScanNotifier: () => null }))
vi.mock("../../src/renderer/features/scores/invalidate", () => ({ useScoreInvalidation: () => undefined }))
vi.mock("../../src/renderer/lib/whats-new", () => ({ useWhatsNew: () => ({ state: whatsNewState.current }) }))
vi.mock("../../src/renderer/components/BackgroundTasksPanel", () => ({ BackgroundTasksPanel: () => null }))
vi.mock("../../src/renderer/components/SignInBanner", () => ({ SignInBanner: () => null }))
vi.mock("../../src/renderer/components/SupportDialog", () => ({ SupportDialog: supportDialog }))
vi.mock("../../src/renderer/components/TenantSwitcher", () => ({ TenantSwitcher: () => null }))
vi.mock("../../src/renderer/components/UpdateSidebarLabel", () => ({ UpdateSidebarLabel: () => null }))
vi.mock("../../src/renderer/components/WhatsNewDialog", () => ({ WhatsNewAnnouncement: () => null, WhatsNewDialog: whatsNewDialog }))
vi.mock("../../src/renderer/components/TenantAccessNotice", () => ({ TenantAccessNotice: () => null }))
vi.mock("../../src/renderer/components/oib/JobIndicator", () => ({ OibJobIndicator: () => null, OibJobCard: () => null }))
vi.mock("../../src/renderer/features/custom-baselines/api", () => ({ customizeOib: vi.fn() }))
vi.mock("../../src/renderer/lib/appearance", () => ({ getAppearance: () => "light", setAppearance: () => undefined }))

import { DesktopLayout } from "../../src/renderer/components/DesktopLayout"
import { feedbackPageLabel } from "../../src/shared/feedback"
import { FrameworkNavigation } from "../../src/renderer/components/FrameworkNavigation"
import { CustomizeCard } from "../../src/renderer/pages/OibPage"
import { SettingsSectionNav } from "../../src/renderer/pages/SettingsPage"
import { ViewAllActivityButton } from "../../src/portal/app/portal/dashboard/page"
import { NAV_PLAN_FEATURES } from "../../src/renderer/components/NavPlanBadge"
import { HUBS } from "../../src/renderer/features/hubs"

// Long enough for a chosen Help item to launch: the menu's exit, two paints, then two more before the capture.
const LAUNCH_MS = 160

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
  whatsNewState.current = null
  menuAtCapture.length = 0
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

const PAID_ENTRIES = [["Audit Log", "/portal/audit"], ["Copy to Tenants", "/portal/sync"], ["Governance", "/portal/governance"], ["Changes", "/portal/changes"], ["Operations", "/portal/operations"], ["Reports", "/portal/reports"], ["Alerts", "/portal/alerts"]] as const

function sidebarLink(container: HTMLElement, href: string): HTMLAnchorElement {
  return container.querySelector<HTMLAnchorElement>(`nav[aria-label="Main navigation"] a[href="${href}"]`)!
}

describe("sidebar plan badges for paid screens", () => {
  it("places Services after Backup & Restore without changing the other navigation order", async () => {
    const container = await render(createElement(DesktopLayout))
    const nav = container.querySelector('nav[aria-label="Main navigation"]')!
    const group = nav.querySelector('section[aria-label="Services"]')!
    expect(group.querySelector("h2")?.textContent).toBe("Services")
    expect([...group.querySelectorAll("a")].map(link => link.textContent)).toEqual(["Intune", "Entra ID", "Defender"])
    expect(group.previousElementSibling?.textContent).toBe("Backup & Restore")
    expect(group.closest("#nav-items-Protect")).not.toBeNull()
    for (const link of group.querySelectorAll("a")) expect(link.hasAttribute("data-nav-row")).toBe(true)
    expect(group.parentElement?.nextElementSibling?.textContent).toContain("App Backup")
    const filtered = await render(createElement(DesktopLayout), "/portal/backup?service=entra")
    expect(sidebarLink(filtered, "/portal/backup").className).not.toContain("bg-primary")
    const unknown = await render(createElement(DesktopLayout), "/portal/backup?service=unknown")
    expect(sidebarLink(unknown, "/portal/backup").className).toContain("bg-primary")
  })

  it("badges each hub by all of its tabs, and the audit log and Sync by their feature", () => {
    expect(NAV_PLAN_FEATURES["/portal/audit"]).toEqual(["auditLog"])
    expect(NAV_PLAN_FEATURES["/portal/sync"]).toEqual(["sync"])
    for (const hub of HUBS) expect(NAV_PLAN_FEATURES[`/portal/${hub.id}`]).toEqual(hub.tabs.map((tab) => tab.feature))
    expect(Object.keys(NAV_PLAN_FEATURES).sort()).toEqual(["/portal/alerts", "/portal/audit", "/portal/changes", "/portal/governance", "/portal/operations", "/portal/reports", "/portal/sync"])
  })

  it("lists Sync directly under Drift Detection, with its hint", async () => {
    licenseStatus.current = statusFor("pro")
    selectTenant()
    const container = await render(createElement(DesktopLayout))
    const hrefs = [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Main navigation"] a')].map((link) => link.getAttribute("href"))
    expect(hrefs[hrefs.indexOf("/portal/drift") + 1]).toBe("/portal/sync")
    expect(sidebarLink(container, "/portal/sync").title).toBe("Copy settings from one tenant to others")
  })

  it("marks Audit Log, Sync, Governance, Changes, Operations, Reports and Alerts with Pro for Community and keeps them links", async () => {
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
    expect(Object.keys(community)).toHaveLength(9)
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


describe("license banners after tenant trials", () => {
  it("suppresses the uncovered banner until the end notice is acknowledged", async () => {
    const end = new Date(Date.now() - 86400_000).toISOString()
    const ended = { ...tenantEntry("t-1", "community"), trialEndsAt: end, trialAcknowledged: false }
    licenseStatus.current = { ...statusFor("community"), tenantTrialsEnabled: true, trialEndedAt: end, tenants: [ended, { ...tenantEntry("uncovered", "community"), plan: null }] }
    selectTenant()
    const container = await render(createElement(DesktopLayout))
    expect(container.textContent).toContain("Pro trial ended")
    expect(container.textContent).not.toContain("not covered by your")
    trialAction.mockImplementationOnce(async () => { ended.trialAcknowledged = true; return undefined })
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Continue on Community")!.click())
    expect(trialAction).toHaveBeenCalledWith("t-1", "acknowledge")
    await act(async () => roots[roots.length - 1]!.render(createElement(MemoryRouter, null, createElement(DesktopLayout))))
    expect(container.textContent).not.toContain("Pro trial ended")
    expect(container.textContent).toContain("not covered by your")
  })
  it.each(["community", "not-covered", "offline", "organization-expiry"])("keeps the %s warning after the end notice is acknowledged", async mode => {
    const end = new Date(Date.now() - 86400_000).toISOString()
    const past = { ...tenantEntry("ended", "community", mode === "not-covered"), plan: null, trialEndsAt: end, trialAcknowledged: true }
    const status = { ...statusFor(mode === "community" || mode === "not-covered" ? "community" : "pro"), hasKey: false, tenantTrialsEnabled: true, validUntil: null as string | null, trialEndedAt: end, offline: mode === "offline", tenants: [] as unknown[] }
    const active = mode === "community" || mode === "not-covered" ? tenantEntry("t-1", "community") : { ...tenantEntry("t-1", "pro"), source: "tenant", expiresAt: new Date(Date.now() + (mode === "offline" ? 1 : 10) * 86400_000).toISOString(), validUntil: new Date(Date.now() + (mode === "offline" ? 50 : 1) * 86400_000).toISOString() }
    status.validUntil = active.validUntil
    status.tenants = [active, past]
    licenseStatus.current = status; selectTenant()
    // On the dashboard the trial card for t-1 takes the Community notice's place; the overview keeps it.
    const container = await render(createElement(DesktopLayout), mode === "community" ? "/portal/overview" : undefined)
    const expected = { community: "You are on Community, the free plan.", "not-covered": "not covered by your", offline: "could not reach the licensing service", "organization-expiry": "The license shared by your organization" }[mode]!
    expect(container.textContent).toContain(expected)
  })
  it.each(["/license", "/portal/onboarding", "/portal/overview"])("renders a global welcome only when the route does not own it (%s)", async route => {
    const end = new Date(Date.now() + 9 * 86400_000).toISOString()
    licenseStatus.current = { ...statusFor("pro"), hasKey: false, trial: true, tenantTrialsEnabled: true, trialEndsAt: end, tenants: [{ ...tenantEntry("t-1", "pro"), source: "trial", trial: true, trialEndsAt: end, trialAcknowledged: false }] }
    selectTenant()
    const container = await render(createElement(DesktopLayout), route)
    expect(container.textContent?.includes("Pro trial started")).toBe(route === "/portal/overview")
  })
})

describe("License badge in the sidebar", () => {
  const TRIAL_ENDS = new Date(Date.now() + 13.5 * 86_400_000).toISOString()
  // One tenant runs the Pro trial, the other is licensed through its organization (MSP).
  const mixed = {
    ...statusFor("pro"), hasKey: false, keyState: "none", plan: "pro", tenantLimit: 2, trial: true, trialEndsAt: TRIAL_ENDS,
    tenants: [
      { ...tenantEntry("t-trial", "pro"), source: "trial", trial: true, trialEndsAt: TRIAL_ENDS, validUntil: TRIAL_ENDS },
      { ...tenantEntry("t-org", "msp"), source: "tenant", tenants: 10 },
    ],
  }
  const badge = (container: HTMLElement) => container.querySelector(`a[href="/license"]`)?.textContent

  it("shows the selected tenant's organization license, not the other tenant's trial", async () => {
    licenseStatus.current = mixed
    signedInIds.current = new Set(["t-trial", "t-org"])
    selectedTenantState.current = { id: 2, name: "Fabrikam", credentials: { tenantId: "t-org", appId: "app-2", clientSecret: "" } }
    const container = await render(createElement(DesktopLayout))
    expect(badge(container)).toContain("Organization")
    expect(badge(container)).not.toContain("Pro trial")
  })

  it("shows the trial and its days left for the tenant that runs it", async () => {
    licenseStatus.current = mixed
    signedInIds.current = new Set(["t-trial", "t-org"])
    selectedTenantState.current = { id: 1, name: "Contoso", credentials: { tenantId: "t-trial", appId: "app-1", clientSecret: "" } }
    const container = await render(createElement(DesktopLayout))
    expect(badge(container)).toContain("Pro trial")
    expect(badge(container)).toContain("14d")
  })
})

describe("sidebar groups and Help", () => {
  const groupOf = (container: HTMLElement, label: string) => {
    const heading = [...container.querySelectorAll('nav[aria-label="Main navigation"] button[id^="nav-group-"]')].find((item) => item.textContent === label)!
    return heading.closest('[role="group"]')!
  }
  const hrefs = (root: Element) => [...root.querySelectorAll("a")].map((link) => link.getAttribute("href"))
  const openHelp = async (container: HTMLElement) => {
    const trigger = [...container.querySelectorAll("aside button")].find((item) => item.textContent?.startsWith("Help"))!
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    return trigger
  }
  const menuItem = (label: string) => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.startsWith(label)) as HTMLElement | undefined
  const choose = async (label: string) => {
    await act(async () => { menuItem(label)!.click() })
    // The item runs after the menu has closed and the window has painted.
    for (let wait = 0; wait < 40 && document.querySelector('[role="menu"]'); wait++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
  }

  it("puts every entry under Protect, Baselines or Oversight, after the ungrouped start entries", async () => {
    licenseStatus.current = statusFor("pro")
    selectTenant()
    const container = await render(createElement(DesktopLayout))
    const headings = [...container.querySelectorAll('nav[aria-label="Main navigation"] button[id^="nav-group-"]')].map((item) => item.textContent)
    expect(headings).toEqual(["Protect", "Baselines", "Oversight"])
    expect(hrefs(groupOf(container, "Protect"))).toEqual(["/portal/backup", "/portal/backup?service=intune", "/portal/backup?service=entra", "/portal/backup?service=defender", "/portal/app-backup", "/portal/drift", "/portal/sync", "/portal/alerts"])
    expect(hrefs(groupOf(container, "Baselines"))).toEqual(expect.arrayContaining(["/portal/oib", "/portal/frameworks/cis-benchmarks", "/portal/frameworks"]))
    expect(hrefs(groupOf(container, "Oversight"))).toEqual(["/portal/reports", "/portal/audit", "/portal/governance", "/portal/changes", "/portal/operations"])
  })

  it("keeps Settings and License in the footer and moves What's new, Share feedback and Support into Help", async () => {
    licenseStatus.current = statusFor("pro")
    selectTenant()
    const container = await render(createElement(DesktopLayout))
    const aside = container.querySelector("aside")!
    expect(aside.textContent).not.toContain("Desktop")
    expect(aside.textContent).not.toContain("Share feedback")
    expect(aside.querySelector('a[href="/portal/settings"]')).not.toBeNull()
    await openHelp(container)
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["What's new", "Share feedback", "SupportDocumentation, contact options and a free setup call"])
  })

  it("opens Support, What's new and a feedback capture from the Help menu", async () => {
    licenseStatus.current = statusFor("pro")
    selectTenant()
    const container = await render(createElement(DesktopLayout))
    await openHelp(container)
    await choose("Support")
    expect(supportDialog.mock.lastCall?.[0].open).toBe(true)
    await openHelp(container)
    await choose("What's new")
    expect(whatsNewDialog.mock.lastCall?.[0].open).toBe(true)
    await openHelp(container)
    await choose("Share feedback")
    expect(feedbackCapture).toHaveBeenCalledTimes(1)
    expect(menuAtCapture).toEqual([false])
  })

  it("keeps Help closed until a chosen item has done its work, and hands focus back to Help even if it moved", async () => {
    licenseStatus.current = statusFor("pro")
    selectTenant()
    const container = await render(createElement(DesktopLayout))
    const trigger = await openHelp(container)
    // A second choice made while the menu closes (Support here) is ignored: Share feedback, chosen first, runs.
    const support = menuItem("Support")!
    await act(async () => { menuItem("Share feedback")!.click(); support.click() })
    // Reopening Help before the window is captured does nothing, so the menu cannot be in the screenshot.
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    expect(feedbackCapture).toHaveBeenCalledTimes(1)
    expect(menuAtCapture).toEqual([false])
    expect(supportDialog.mock.calls.some(([props]) => props.open)).toBe(false)

    await openHelp(container)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => { menuItem("Support")!.click() })
    // Focus moves elsewhere before the queued item runs: Support still returns to Help.
    container.querySelector<HTMLAnchorElement>('a[href="/portal/settings"]')!.focus()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    const props = supportDialog.mock.lastCall?.[0] as { open: boolean; returnFocus?: { current: HTMLElement | null } }
    expect(props.open).toBe(true)
    expect(props.returnFocus?.current).toBe(trigger)
  })

  it("labels the feedback with the page open when the capture starts, not when Share feedback was chosen", async () => {
    licenseStatus.current = statusFor("pro")
    selectTenant()
    let go: (path: string) => void = () => undefined
    function Navigator() { go = useNavigate(); return null }
    const container = await render(createElement("div", null, createElement(Navigator), createElement(DesktopLayout)))
    await openHelp(container)
    // The user moves on to Settings while the menu closes; the screenshot then shows Settings.
    await act(async () => { menuItem("Share feedback")!.click(); go("/portal/settings") })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    expect(feedbackCapture).toHaveBeenCalledTimes(1)
    expect(feedbackCapture.mock.calls[0]![0]).toBe(feedbackPageLabel("/portal/settings"))
    expect(feedbackPageLabel("/portal/settings")).not.toBe(feedbackPageLabel("/portal/dashboard"))
  })

  it("captures again when the page changes while the window is being captured", async () => {
    licenseStatus.current = statusFor("pro")
    selectTenant()
    let finishCapture: () => void = () => undefined
    feedbackCapture.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = () => resolve(null) }))
    let go: (path: string) => void = () => undefined
    function Navigator() { go = useNavigate(); return null }
    const container = await render(createElement("div", null, createElement(Navigator), createElement(DesktopLayout)))
    await openHelp(container)
    await choose("Share feedback")
    expect(feedbackCapture).toHaveBeenCalledTimes(1)
    expect(feedbackCapture.mock.calls[0]![0]).toBe("Dashboard")
    // Settings paints while the capture is still running, so that screenshot may show either page.
    await act(async () => go("/portal/settings"))
    await act(async () => { finishCapture(); await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    expect(feedbackCapture).toHaveBeenCalledTimes(2)
    expect(feedbackCapture.mock.calls[1]![0]).toBe(feedbackPageLabel("/portal/settings"))
  })

  describe("captures that the page changes under", () => {
    const held: Array<() => void> = []
    const holdCaptures = (count: number) => {
      for (let index = 1; index <= count; index++) {
        feedbackCapture.mockImplementationOnce(() => new Promise((resolve) => { held.push(() => resolve({ id: `s${index}` } as never)) }))
      }
    }
    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    const start = async () => {
      licenseStatus.current = statusFor("pro")
      selectTenant()
      let navigate: ReturnType<typeof useNavigate> = () => undefined
      function Navigator() { navigate = useNavigate(); return null }
      const container = await render(createElement("div", null, createElement(Navigator), createElement(DesktopLayout)))
      await openHelp(container)
      await choose("Share feedback")
      return (to: string | number) => act(async () => { if (typeof to === "number") void navigate(to); else void navigate(to) })
    }
    afterEach(() => { held.splice(0) })

    it("captures again after a round trip back to the same page", async () => {
      holdCaptures(1)
      const go = await start()
      // Settings may be what the window showed while it was captured, even though Dashboard is back.
      await go("/portal/settings")
      await go("/portal/dashboard")
      await act(async () => held.shift()!())
      await settle()
      expect(feedbackCapture.mock.calls.map(([page]) => page)).toEqual(["Dashboard", "Dashboard"])
      expect(discardCapture.mock.calls.map(([id]) => id)).toEqual(["s1"])
    })

    it("captures again after Back and Forward return to the same history entry", async () => {
      holdCaptures(2)
      const go = await start()
      await go("/portal/settings")
      await act(async () => held.shift()!())
      await settle()
      expect(feedbackCapture.mock.calls.map(([page]) => page)).toEqual(["Dashboard", "Settings"])
      // Dashboard may be in this screenshot, though Forward brings back the very same Settings entry.
      await go(-1)
      await go(1)
      await act(async () => held.shift()!())
      await settle()
      expect(feedbackCapture.mock.calls.map(([page]) => page)).toEqual(["Dashboard", "Settings", undefined])
      expect(discardCapture.mock.calls.map(([id]) => id)).toEqual(["s1", "s2"])
    })

    it("names no page in the last capture when the page keeps changing, and keeps that capture", async () => {
      holdCaptures(3)
      const go = await start()
      await go("/portal/settings")
      await act(async () => held.shift()!())
      await settle()
      await go("/portal/drift")
      await act(async () => held.shift()!())
      await settle()
      await go("/portal/audit")
      await act(async () => held.shift()!())
      await settle()
      expect(feedbackCapture.mock.calls.map(([page]) => page)).toEqual(["Dashboard", "Settings", undefined])
      // The draft the dialog opens with is the last capture, which is still valid.
      expect(discardCapture.mock.calls.map(([id]) => id)).toEqual(["s1", "s2"])
    })
  })

  it("ignores a choice made in a dismissed menu while it animates out", async () => {
    // jsdom applies no stylesheets: give the menu its exit animation, so it stays mounted after Escape
    // until the animation ends, as it does in the app.
    const real = window.getComputedStyle.bind(window)
    const styles = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = real(element, pseudo)
      if (!(element as Element).classList?.contains("tv-pop")) return style
      // Radix reads the same style object again as the menu closes, so the name follows data-state.
      const animationName = () => (element as Element).getAttribute("data-state") === "closed" ? "tv-pop-out" : "tv-pop-in"
      return new Proxy(style, { get: (target, key) => key === "animationName" ? animationName() : Reflect.get(target, key) })
    })
    try {
      licenseStatus.current = statusFor("pro")
      selectTenant()
      const container = await render(createElement(DesktopLayout))
      await openHelp(container)
      const feedback = menuItem("Share feedback")!
      await act(async () => { feedback.focus() })
      await act(async () => { feedback.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
      const menu = document.querySelector('[role="menu"]')!
      expect(menu.getAttribute("data-state")).toBe("closed")
      await act(async () => { feedback.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
      await act(async () => { menu.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "tv-pop-out" })) })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
      expect(document.querySelector('[role="menu"]')).toBeNull()
      expect(feedbackCapture).not.toHaveBeenCalled()
      // Help opens again, since nothing was launched.
      await openHelp(container)
      expect(document.querySelector('[role="menu"]')?.getAttribute("data-state")).toBe("open")
    } finally {
      styles.mockRestore()
    }
  })

  it("keeps Help closed while a capture is pending, also after the sidebar left and came back", async () => {
    // No tenants: the sidebar shows on License and gives way to the guided setup on the onboarding route.
    licenseStatus.current = statusFor("pro")
    let finishCapture: () => void = () => undefined
    feedbackCapture.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = () => resolve(null) }))
    let go: (path: string) => void = () => undefined
    function Navigator() { go = useNavigate(); return null }
    const container = await render(createElement("div", null, createElement(Navigator), createElement(DesktopLayout)), "/license")
    await openHelp(container)
    await act(async () => { menuItem("Share feedback")!.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    expect(feedbackCapture).toHaveBeenCalledTimes(1)
    await act(async () => go("/portal/onboarding"))
    expect(container.querySelector("aside")).toBeNull()
    await act(async () => go("/license"))
    expect(container.querySelector("aside")).not.toBeNull()
    await openHelp(container)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await act(async () => { finishCapture(); await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
  })

  it("keeps Help closed while a capture started from the first-run header is pending", async () => {
    licenseStatus.current = statusFor("pro")
    let finishCapture: () => void = () => undefined
    feedbackCapture.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = () => resolve(null) }))
    let go: (path: string) => void = () => undefined
    function Navigator() { go = useNavigate(); return null }
    const container = await render(createElement("div", null, createElement(Navigator), createElement(DesktopLayout)), "/portal/onboarding")
    const header = [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Help"] button')].find((button) => button.textContent === "Share feedback")!
    await act(async () => header.click())
    // The capture starts once the page has painted.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    expect(feedbackCapture).toHaveBeenCalledTimes(1)
    await act(async () => go("/license"))
    await openHelp(container)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    // The page changed under that capture, so it is taken again before the dialog opens.
    await act(async () => { finishCapture(); await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
  })

  it("returns focus to the current Help button when feedback closes after the sidebar came back", async () => {
    licenseStatus.current = statusFor("pro")
    let finishCapture: () => void = () => undefined
    feedbackCapture.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = () => resolve(null) }))
    let go: (path: string) => void = () => undefined
    function Navigator() { go = useNavigate(); return null }
    const container = await render(createElement("div", null, createElement(Navigator), createElement(DesktopLayout)), "/license")
    const first = await openHelp(container)
    await act(async () => { menuItem("Share feedback")!.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    await act(async () => go("/portal/onboarding"))
    await act(async () => go("/license"))
    const help = [...container.querySelectorAll("aside button")].find((button) => button.textContent?.startsWith("Help"))!
    expect(help).not.toBe(first)
    await act(async () => { finishCapture(); await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain("Share feedback")
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(help)
  })

  it("still opens a chosen What's new when the sidebar leaves before it launches", async () => {
    licenseStatus.current = statusFor("pro")
    let go: (path: string) => void = () => undefined
    function Navigator() { go = useNavigate(); return null }
    const container = await render(createElement("div", null, createElement(Navigator), createElement(DesktopLayout)), "/license")
    await openHelp(container)
    await act(async () => { menuItem("What's new")!.click() })
    await act(async () => go("/portal/onboarding"))
    expect(container.querySelector("aside")).toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS)) })
    expect(whatsNewDialog.mock.lastCall?.[0].open).toBe(true)
    // With no sidebar, focus goes back to the guided setup's Support button when the dialog closes.
    const props = whatsNewDialog.mock.lastCall?.[0] as { returnFocus?: { current: HTMLElement | null } }
    expect(props.returnFocus?.current?.textContent).toBe("Support")
    expect(props.returnFocus?.current?.closest('nav[aria-label="Help"]')).not.toBeNull()
  })

  it("marks Help and What's new while an installed build is unseen", async () => {
    licenseStatus.current = statusFor("pro")
    selectTenant()
    whatsNewState.current = { hasUnseen: true }
    const container = await render(createElement(DesktopLayout))
    const trigger = await openHelp(container)
    expect(trigger.getAttribute("aria-label")).toBe("Help, new changes since you last looked")
    expect(menuItem("What's new")!.textContent).toBe("What's new, new changes since you last looked")
  })
})

describe("folding sidebar groups", () => {
  const head = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`button#nav-group-${label}`)!

  it("folds a group from its heading, makes its entries inert and remembers it", async () => {
    localStorage.removeItem("tenuvault.sidebar.folded")
    licenseStatus.current = statusFor("pro")
    selectTenant()
    const container = await render(createElement(DesktopLayout), "/portal/reports")
    const oversight = head(container, "Oversight")
    expect(oversight.getAttribute("aria-expanded")).toBe("true")
    await act(async () => oversight.click())
    expect(oversight.getAttribute("aria-expanded")).toBe("false")
    const items = container.querySelector("#nav-items-Oversight")!
    expect(items.getAttribute("data-open")).toBe("false")
    expect(items.querySelector(".tv-fold-inner")!.hasAttribute("inert")).toBe(true)
    // The open page is inside the folded group, so its heading says so.
    expect(oversight.textContent).toBe("Oversight, holds the open page")
    expect(JSON.parse(localStorage.getItem("tenuvault.sidebar.folded")!)).toEqual(["Oversight"])

    const again = await render(createElement(DesktopLayout), "/portal/dashboard")
    expect(head(again, "Oversight").getAttribute("aria-expanded")).toBe("false")
    expect(head(again, "Oversight").textContent).toBe("Oversight")
    expect(head(again, "Protect").getAttribute("aria-expanded")).toBe("true")
    localStorage.removeItem("tenuvault.sidebar.folded")
  })

  it("rings the keyboard-focused row of the sidebar menus, whose fill alone is too soft to see", () => {
    const css = readFileSync("src/renderer/desktop.css", "utf8")
    expect(css).toContain('.tv-pop [role="menuitem"]:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }')
  })

  it("reveals and hides folding rows by clipping only, so labels in view never lose contrast", () => {
    const css = readFileSync("src/renderer/desktop.css", "utf8")
    const fold = css.split("\n").filter((line) => /^\.tv-fold(\[|-inner| )/.test(line)).join("\n")
    expect(fold).toContain("grid-template-rows: 0fr")
    expect(fold).not.toMatch(/opacity|filter|blur/)
    // Folded rows are hidden once the fold has closed.
    expect(fold).toMatch(/data-open="false"\] > \.tv-fold-inner \{[^}]*visibility: hidden/)
    // With reduced motion the closed rule's delayed visibility change goes too, so rows hide at once.
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".tv-fold {")))
    expect(reduced.slice(0, reduced.indexOf("\n}"))).toContain(".tv-fold[data-open] > .tv-fold-inner { transition: none; }")
  })

  it("marks the entry of the open page for the sliding pill", async () => {
    licenseStatus.current = statusFor("pro")
    selectTenant()
    const container = await render(createElement(DesktopLayout), "/portal/drift")
    const current = [...container.querySelectorAll('nav[aria-label="Main navigation"] [aria-current="page"]')]
    expect(current.map((element) => element.getAttribute("href"))).toEqual(["/portal/drift"])
    expect(current[0]!.hasAttribute("data-nav-row")).toBe(true)
    // No row fades its fill or label: the open page's white label never passes through its background's shade.
    for (const row of container.querySelectorAll("[data-nav-row]")) expect(row.className, row.textContent ?? "").not.toMatch(/\btransition(-colors|-all)?\b/)
  })
})
