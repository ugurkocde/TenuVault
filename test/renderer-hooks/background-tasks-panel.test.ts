import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Link, MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver

const tenantId = "11111111-1111-1111-1111-111111111111"
const appId = "22222222-2222-2222-2222-222222222222"

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { app: { info: async () => ({}), openExternal: async () => undefined }, license: { open: async () => undefined }, reports: { saveFile: async () => ({ saved: false }) } },
}))
vi.mock("../../src/renderer/lib/license", () => ({
  useTenantPlan: () => "pro",
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
  tenantLicense: () => undefined,
  tenantPlan: () => null,
}))
vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId } }, selectedTenantId: "local", setSelectedTenantId: () => undefined }),
  useTenants: () => [{ id: "local", name: "Synthetic tenant", credentials: { tenantId, appId } }],
}))

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BackgroundTasksPanel } from "../../src/renderer/components/BackgroundTasksPanel"
import HygieneTab from "../../src/renderer/features/hygiene/HygieneTab"
import { clearFinishedBackgroundTasks, startBackgroundTask } from "../../src/renderer/lib/background-tasks"
import { Toaster } from "../../src/renderer/lib/toast"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

const startedAt = new Date(Date.now() - 5000).toISOString()
let driftJob: Record<string, unknown>
let nativeJob: Record<string, unknown>
let cisJob: Record<string, unknown>
const requests: { path: string; body: Record<string, unknown> }[] = []
let finishHygieneFetch = (_response: Response) => {}
const hygieneList = { rules: [], scans: [], findings: [], total: 0 }

function stubMain() {
  driftJob = { jobId: "drift-1", tenantId, status: "running", phase: "comparing", detail: "Comparing the backups", done: 4, total: 10, percent: 40, startedAt, baseline: null, comparison: null }
  nativeJob = { jobId: "native-1", tenantId, frameworkId: "iso-27001", frameworkName: "ISO 27001", status: "running", step: "collecting", detail: "Reading policies", percent: 25, startedAt }
  cisJob = { jobId: "cis-1", tenantId, frameworkId: "cis-benchmarks", reference: "intune-windows11 5.0.0 Level 1", phase: "reading", status: "running", read: 5, total: 10, currentPolicy: "", comparedPolicies: 0, packPolicies: 4, currentPackPolicy: "", findingsCount: 0, error: null, runId: null, startedAt, finishedAt: null }
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ path, body })
    if (path === "/api/drift-scan") {
      if (body.action === "jobs") return Response.json({ jobs: [driftJob] })
      if (body.action === "cancel") { driftJob = { ...driftJob, status: "cancelled", detail: "Drift scan cancelled", finishedAt: new Date().toISOString() }; return Response.json({ job: driftJob }) }
      if (body.action === "result") return Response.json({ result: null })
    }
    if (path === "/api/hygiene") {
      if (body.action === "scan") return new Promise<Response>((resolve) => { finishHygieneFetch = resolve })
      return Response.json(hygieneList)
    }
    if (path === "/api/frameworks") {
      if (body.action === "native-jobs") return Response.json({ jobs: [nativeJob] })
      if (body.action === "assess-jobs") return Response.json({ jobs: [cisJob] })
    }
    return Response.json({ error: "unexpected" }, { status: 500 })
  }))
}

const roots: Root[] = []
function mount(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return container
}
async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error("Condition not met in time.")
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }
}
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }) }
const byText = (container: HTMLElement, text: string) => [...container.querySelectorAll("button, a")].find((item) => item.textContent === text)

let finishScan = (_value: string) => {}
function PageA() {
  return createElement("div", null,
    createElement("button", { type: "button", onClick: () => startBackgroundTask("hygiene:test", { title: "Hygiene scan", detail: "Scanning the latest backup", href: "/portal/governance/hygiene" }, () => new Promise<string>((resolve) => { finishScan = resolve })) }, "Start hygiene scan"),
    createElement(Link, { to: "/b" }, "Go to page B"),
  )
}
function PageB() {
  return createElement("div", null, createElement("p", null, "Page B"), createElement(Link, { to: "/a" }, "Back to page A"))
}

describe("background activity panel", () => {
  beforeEach(() => { requests.length = 0; stubMain() })
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount())
    document.body.innerHTML = ""
    clearFinishedBackgroundTasks()
    vi.unstubAllGlobals()
  })

  it("shows every running job with progress while navigating, and reports cancellation and completion", async () => {
    const container = mount(createElement(MemoryRouter, { initialEntries: ["/a"] },
      createElement(Routes, null,
        createElement(Route, { path: "/a", element: createElement(PageA) }),
        createElement(Route, { path: "/b", element: createElement(PageB) }),
      ),
      createElement(BackgroundTasksPanel),
      createElement(Toaster),
    ))

    // Mirrored main-process jobs appear with their progress.
    await waitFor(() => container.textContent.includes("Drift scan") && container.textContent.includes("40%"))
    expect(container.textContent).toContain("ISO 27001 comparison")
    expect(container.textContent).toContain("25%")
    expect(container.textContent).toContain("CIS assessment")
    expect(container.textContent).toContain("24%")
    expect(container.textContent).toContain("3 running")

    // A renderer task started by a real button click joins the panel.
    await click(byText(container, "Start hygiene scan"))
    await waitFor(() => container.textContent.includes("Hygiene scan"))
    expect(container.textContent).toContain("4 running")
    expect(container.querySelector('[role="progressbar"][aria-label="Hygiene scan in progress"]')).not.toBeNull()

    // Navigation stays responsive and the panel persists on the other page.
    const before = performance.now()
    await click(byText(container, "Go to page B"))
    expect(performance.now() - before).toBeLessThan(1000)
    await waitFor(() => container.textContent.includes("Page B"))
    expect(container.textContent).toContain("Drift scan")
    expect(container.textContent).toContain("Hygiene scan")

    // Cancel sends the cancel action for that job and the entry turns cancelled.
    const panel = container.querySelector('[aria-label="Background activity"]') as HTMLElement
    await click(byText(panel, "Cancel"))
    await waitFor(() => requests.some((request) => request.path === "/api/drift-scan" && request.body.action === "cancel"))
    await waitFor(() => panel.textContent.includes("Drift scan cancelled"))

    // Finishing the local task shows its outcome in the panel and toasts away from its page.
    await act(async () => { finishScan("Hygiene scan finished.") })
    await waitFor(() => panel.textContent.includes("Hygiene scan finished."))
    await waitFor(() => container.textContent.includes("View results"))
    expect([...container.querySelectorAll("a")].some((link) => link.getAttribute("href")?.includes("/portal/drift"))).toBe(true)

    // Dismiss removes the finished entry.
    await click(panel.querySelector('[aria-label="Dismiss Hygiene scan"]'))
    await waitFor(() => !panel.textContent.includes("Hygiene scan finished."))
  })

  it("runs the real hygiene scan button in the background across unmount and return", async () => {
    const tenant = { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId } } as unknown as Tenant
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = mount(createElement(QueryClientProvider, { client },
      createElement(MemoryRouter, { initialEntries: ["/hygiene"] },
        createElement(Routes, null,
          createElement(Route, { path: "/hygiene", element: createElement("div", null, createElement(HygieneTab, { tenant, plan: "pro", allowed: true }), createElement(Link, { to: "/elsewhere" }, "Leave hygiene")) }),
          createElement(Route, { path: "/elsewhere", element: createElement("div", null, createElement("p", null, "Elsewhere"), createElement(Link, { to: "/hygiene" }, "Return to hygiene")) }),
        ),
        createElement(BackgroundTasksPanel),
        createElement(Toaster),
      ),
    ))

    await waitFor(() => !!byText(container, "Scan latest backup"))
    await click(byText(container, "Scan latest backup"))
    await waitFor(() => !!byText(container, "Scanning in background"))
    expect(requests.some((request) => request.path === "/api/hygiene" && request.body.action === "scan")).toBe(true)

    // Leave the tab entirely; the panel keeps the running scan.
    await click(byText(container, "Leave hygiene"))
    await waitFor(() => container.textContent.includes("Elsewhere"))
    const panel = container.querySelector('[aria-label="Background activity"]') as HTMLElement
    expect(panel.textContent).toContain("Hygiene scan")

    // Finish the scan in main; panel and toast report it on the other page.
    await act(async () => { finishHygieneFetch(Response.json(hygieneList)) })
    await waitFor(() => panel.textContent.includes("Hygiene scan of Synthetic tenant finished."))
    await waitFor(() => [...container.querySelectorAll("a")].some((link) => link.textContent === "View results"))

    // Returning shows the tab usable again, not stuck scanning.
    await click(byText(container, "Return to hygiene"))
    await waitFor(() => !!byText(container, "Scan latest backup"))
  })
})
