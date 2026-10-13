import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appInfo = vi.hoisted(() => vi.fn())

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { app: { info: appInfo } },
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
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
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

describe("CIS Benchmarks top-level sidebar entry", () => {
  it("renders the CIS item after Operations placement with the internal flag on", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
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
    const container = render(sidebarHarness("/portal/operations"))
    await flush()
    const link = container.querySelector('a[href="/portal/frameworks/cis-benchmarks"]')
    expect(link).not.toBeNull()
    expect(link?.className).not.toContain("active")
    expect(link?.getAttribute("aria-current")).toBeNull()
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
    expect(container.textContent).toContain("Import a Build Kit")
    expect(container.textContent).toContain("Choose your policy pack")
    expect(container.textContent).toContain("Select Build Kit zip")
    expect(container.textContent).toContain("Select recommendation list JSON")
    const heading = [...container.querySelectorAll("h1")].find((item) => item.textContent === "CIS Benchmarks")
    expect(heading?.className).toContain("text-4xl")
    expect(heading?.className).toContain("font-light")
    const frameworksLinks = [...container.querySelectorAll('a[href="/portal/frameworks"]')]
    expect(frameworksLinks.some((link) => link.textContent.trim() === "Frameworks")).toBe(false)
  })
})
