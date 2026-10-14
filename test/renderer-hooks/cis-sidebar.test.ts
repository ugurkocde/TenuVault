import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appInfo = vi.hoisted(() => vi.fn())
const licenseStatus = vi.hoisted(() => ({ current: null as unknown }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { app: { info: appInfo }, license: { open: async () => undefined } },
}))

vi.mock("../../src/renderer/lib/framework-jobs", () => ({
  useFrameworkJobs: () => [],
}))

vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: null, setSelectedTenantId: () => undefined }),
  useTenants: () => [],
}))

vi.mock("../../src/renderer/lib/license", () => ({
  useTenantPlan: () => null,
  useLicense: () => ({ status: licenseStatus.current, error: null, refresh: async () => undefined }),
  tenantLicense: () => undefined,
  tenantPlan: () => null,
}))

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
  vi.clearAllMocks()
})

function sidebarHarness(route: string) {
  return createElement(
    MemoryRouter,
    { initialEntries: [route] },
    createElement(CisBenchmarksNavigation, { linkClass: (active: boolean) => (active ? "sidebar-link active" : "sidebar-link") }),
  )
}

function entitledStatus(plan: "pro" | "msp") {
  return { hasKey: true, keyState: "active" as const, keyMessage: null, keyHint: "****ABCD", persisted: true, offline: false, message: null, plan, tenantLimit: 2, validUntil: null, communityTenantId: null, tenants: [] }
}

function communityStatus() {
  return { ...entitledStatus("pro"), plan: null, tenants: [{ tenantId: "t1", signedIn: true, activated: false, entitled: false, source: null, plan: "community" as const, tenants: null, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }] }
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
  it("still renders the import panel as a standalone page", async () => {
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
    expect(container.textContent).toContain("1. Import a CIS Build Kit")
    expect(container.textContent).not.toContain("Choose your policy pack")
    expect(container.textContent).not.toContain("Import policy JSON")
    expect(container.textContent).toContain("Select Build Kit zip")
    expect(container.textContent).toContain("Select recommendation list JSON")
    const stepper = container.querySelector('nav[aria-label="CIS Benchmarks progress"] ol')
    expect(stepper).not.toBeNull()
    expect(stepper?.textContent).toContain("1 Import kit")
    expect(stepper?.textContent).toContain("2 Choose level and compare")
    expect(stepper?.textContent).toContain("3 Review results")
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("1 Import kit")
    const heading = [...container.querySelectorAll("h1")].find((item) => item.textContent === "CIS Benchmarks")
    expect(heading?.className).toContain("text-4xl")
    expect(heading?.className).toContain("font-light")
    const frameworksLinks = [...container.querySelectorAll('a[href="/portal/frameworks"]')]
    expect(frameworksLinks.some((link) => link.textContent.trim() === "Frameworks")).toBe(false)
  })
})
