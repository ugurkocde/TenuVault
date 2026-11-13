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
const trialAction = vi.hoisted(() => vi.fn(async () => undefined))
const saved = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { info: async () => ({}) },
    auth: { accounts: async () => [] },
    schedules: { list: async () => [] },
    license: { open: async () => undefined, tenantTrialAction: trialAction },
    preferences: { get: async () => ({ ...saved.current }), set: async (changes: object) => { saved.current = { ...saved.current, ...changes }; return { ...saved.current } } },
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

const BANNER = "You are on Community, the free plan."
const roots: Root[] = []

async function render(route: string): Promise<HTMLDivElement> {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [route] }, createElement(DesktopLayout))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  saved.current = {}
  vi.clearAllMocks()
})

function community(trialsEnabled: boolean) {
  licenseStatus.current = { hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: null, tenantLimit: null, validUntil: null, communityTenantId: "t-1", tenantTrialsEnabled: trialsEnabled, tenants: [{ tenantId: "t-1", signedIn: true, activated: false, entitled: false, source: null, plan: "community", tenants: null, expiresAt: null, validUntil: null, trialEndsAt: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }] }
  selectedTenantState.current = { id: 1, name: "Contoso", credentials: { tenantId: "t-1", appId: "app-1", clientSecret: "" } }
}

describe("Community banner next to the dashboard trial card", () => {
  it("stays away from the dashboard while the card is offered for the selected tenant", async () => {
    community(true)
    expect((await render("/portal/dashboard")).textContent).not.toContain(BANNER)
  })

  it("still shows on the all-tenants overview", async () => {
    community(true)
    expect((await render("/portal/overview")).textContent).toContain(BANNER)
  })

  it("shows on the dashboard once the card was dismissed for the tenant", async () => {
    community(true)
    saved.current = { trialOfferHiddenTenantIds: ["t-1"] }
    expect((await render("/portal/dashboard")).textContent).toContain(BANNER)
  })

  it("shows on the dashboard when no card is offered", async () => {
    community(false)
    expect((await render("/portal/dashboard")).textContent).toContain(BANNER)
  })
})
