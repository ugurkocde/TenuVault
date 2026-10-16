import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HISTORY_FULL_MESSAGE } from "../../src/shared/frameworks/workspace-history"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appInfo = vi.hoisted(() => vi.fn())
const confirmAnswer = vi.hoisted(() => ({ current: true }))
const confirmCalls = vi.hoisted(() => [] as { title: string; description: unknown; confirmLabel?: string }[])
const tenantId = "11111111-1111-1111-1111-111111111111"

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { app: { info: appInfo, openExternal: async () => undefined }, license: { open: async () => undefined } },
}))
vi.mock("../../src/renderer/lib/framework-jobs", () => ({ useFrameworkJobs: () => [] }))
vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId: "22222222-2222-2222-2222-222222222222" } }, selectedTenantId: "local", setSelectedTenantId: () => undefined }),
  useTenants: () => [],
}))
vi.mock("../../src/renderer/lib/license", () => ({
  useTenantPlan: () => "pro",
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
  tenantLicense: () => undefined,
  tenantPlan: () => null,
}))
vi.mock("../../src/portal/components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm: async (options: { title: string; description: unknown; confirmLabel?: string }) => { confirmCalls.push(options); return confirmAnswer.current }, confirmDialog: null }),
}))

import FrameworksPage from "../../src/renderer/pages/FrameworksPage"

const policy = { name: "Synthetic policy", platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark: "synthetic-os", version: "9.9.9", level: "Level 1", sourceFile: "synthetic.json" },
  settings: [{ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: "synthetic_setting", choiceSettingValue: { value: "synthetic_on", children: [] } } }] }
const reference = "synthetic-os 9.9.9 Level 1"

function workspace(frameworkId: string, count: number) {
  const history = Array.from({ length: count }, (_, index) => ({ policies: [policy], assessment: { runId: `run-${index}`, tenantId, frameworkId, reference, assessedAt: new Date(Date.UTC(2026, 0, count - index)).toISOString(), policyCount: 1, findings: [] } }))
  return { version: 1, tenantId, frameworkId, policies: [policy], reference, updatedAt: "2026-10-15T10:00:00Z", history, capacity: { count, limit: 50, full: count >= 50, reason: count >= 50 ? "count" : null } }
}

interface Calls { actions: Record<string, unknown>[] }
/** A local framework service: workspace actions answer from `state`, assessments use `assess`. */
function stubService(frameworkId: string, count: number, assess: (body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 500, body: { error: "unexpected" } })): Calls {
  let current = workspace(frameworkId, count)
  const calls: Calls = { actions: [] }
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== "/api/frameworks") return Response.json({ deployments: [] })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.actions.push(body)
    if (body.action === "workspace-prune-history") current = workspace(frameworkId, Number(body.keep))
    if (body.action === "workspace-open") return Response.json({ workspace: current, activeJob: null })
    if (String(body.action).startsWith("workspace-")) return Response.json(current)
    const result = assess(body)
    return Response.json(result.body, { status: result.status })
  }))
  return calls
}

const roots: Root[] = []
const containers: HTMLDivElement[] = []
function render(frameworkId: string): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  act(() => {
    const root = createRoot(container)
    roots.push(root)
    root.render(createElement(MemoryRouter, { initialEntries: [`/portal/frameworks/${frameworkId}`] }, createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) }))))
  })
  return container
}
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const buttonNamed = (container: HTMLElement, name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name)
const historyAlert = (container: HTMLElement) => container.querySelector('[role="alert"][aria-label="Saved assessment history is full"]')

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  confirmCalls.splice(0)
  confirmAnswer.current = true
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("CIS Benchmarks at the history cap", () => {
  it("shows the cap, disables Run again with that reason, and removes older assessments after confirmation", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const calls = stubService("cis-benchmarks", 50)
    const container = render("cis-benchmarks")
    await flush()
    const alert = historyAlert(container)
    expect(alert?.textContent).toContain("This workspace holds 50 saved assessments, the most it can keep.")
    expect(alert?.textContent).toContain("keeps the newest 10 and permanently deletes the other 40")
    expect(alert?.textContent).toContain("Export saved assessments JSON")
    const start = buttonNamed(container, "Run again")!
    expect(start.disabled).toBe(true)
    expect(start.getAttribute("aria-describedby")).toBe(alert!.id)
    expect(start.title).toContain("history is full")

    await act(async () => { buttonNamed(alert as HTMLElement, "Remove older assessments")!.click() })
    await flush()
    expect(confirmCalls).toHaveLength(1)
    expect(confirmCalls[0]).toMatchObject({ title: "Remove older assessments?", confirmLabel: "Remove 40 assessments" })
    expect(confirmCalls[0]!.description).toContain("keeps the newest 10 saved assessments and removes 40 older assessments")
    expect(confirmCalls[0]!.description).toContain("cannot be restored")
    expect(confirmCalls[0]!.description).toContain("Export saved assessments first")
    expect(calls.actions.filter(body => body.action === "workspace-prune-history")).toEqual([{ action: "workspace-prune-history", tenantId, frameworkId: "cis-benchmarks", keep: 10 }])
    expect(historyAlert(container)).toBeNull()
    expect(buttonNamed(container, "Run again")!.disabled).toBe(false)
    expect(buttonNamed(container, "Run again")!.hasAttribute("aria-describedby")).toBe(false)
  })

  it("disables the one re-run button of the results view with the same reason", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const calls = stubService("cis-benchmarks", 50)
    const container = render("cis-benchmarks")
    await flush()
    await act(async () => { buttonNamed(container, "View read-only")!.click() })
    await flush()
    const alert = historyAlert(container)
    expect(alert).not.toBeNull()
    const run = buttonNamed(container, "Run again")!
    expect(run.disabled).toBe(true)
    expect(run.getAttribute("aria-describedby")).toBe(alert!.id)
    expect(buttonNamed(container, "Run comparison again")).toBeUndefined()
    await act(async () => { run.click() })
    await flush()
    expect(calls.actions.some(body => body.action === "assess" || body.action === "assess-start")).toBe(false)
  })

  it("keeps every assessment when the confirmation is cancelled", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    confirmAnswer.current = false
    const calls = stubService("cis-benchmarks", 50)
    const container = render("cis-benchmarks")
    await flush()
    await act(async () => { buttonNamed(historyAlert(container) as HTMLElement, "Remove older assessments")!.click() })
    await flush()
    expect(confirmCalls).toHaveLength(1)
    expect(calls.actions.some(body => body.action === "workspace-prune-history")).toBe(false)
    expect(historyAlert(container)).not.toBeNull()
    expect(buttonNamed(container, "Run again")!.disabled).toBe(true)
  })

  it("shows a save failure at the end of a run as the full-history alert with the remove action", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const calls = stubService("cis-benchmarks", 49, body => body.action === "assess-start"
      ? { status: 200, body: { jobId: "job-1" } }
      : { status: 200, body: { jobId: "job-1", phase: "failed", status: "failed", state: "failed", tenantId, frameworkId: "cis-benchmarks", read: 1, total: 1, currentPolicy: "", comparedPolicies: 1, packPolicies: 1, currentPackPolicy: "", findings: [], nextSince: 0, error: HISTORY_FULL_MESSAGE, assessment: null } })
    const container = render("cis-benchmarks")
    await flush()
    expect(historyAlert(container)).toBeNull()
    await act(async () => { buttonNamed(container, "Run again")!.click() })
    await flush()
    const alert = historyAlert(container)
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain("Remove older assessments")
    // The raw error is not repeated as a separate small line.
    expect([...container.querySelectorAll('p[role="alert"]')].some(item => item.textContent === HISTORY_FULL_MESSAGE)).toBe(false)
    expect(buttonNamed(container, "Run again")!.disabled).toBe(true)
    await act(async () => { buttonNamed(alert as HTMLElement, "Remove older assessments")!.click() })
    await flush()
    expect(confirmCalls[0]!.confirmLabel).toBe("Remove 39 assessments")
    expect(calls.actions.some(body => body.action === "workspace-prune-history" && body.keep === 10)).toBe(true)
    expect(historyAlert(container)).toBeNull()
    expect(buttonNamed(container, "Run again")!.disabled).toBe(false)
  })

  it("shows the same alert when the service refuses to start because the history is full", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    stubService("cis-benchmarks", 20, () => ({ status: 409, body: { error: HISTORY_FULL_MESSAGE } }))
    const container = render("cis-benchmarks")
    await flush()
    await act(async () => { buttonNamed(container, "Run again")!.click() })
    await flush()
    expect(historyAlert(container)?.textContent).toContain("have reached the storage limit on this device")
    expect(buttonNamed(container, "Run again")!.disabled).toBe(true)
  })
})

describe("Policy-pack frameworks at the history cap", () => {
  it("disables Run comparison and offers the same remove action", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    const calls = stubService("custom", 50)
    const container = render("custom")
    await flush()
    const alert = historyAlert(container)
    expect(alert?.textContent).toContain("This workspace holds 50 saved assessments")
    expect(alert?.textContent).toContain("Export saved assessments")
    expect(buttonNamed(container, "Run comparison")!.disabled).toBe(true)
    await act(async () => { buttonNamed(alert as HTMLElement, "Remove older assessments")!.click() })
    await flush()
    expect(calls.actions.some(body => body.action === "workspace-prune-history" && body.frameworkId === "custom" && body.keep === 10)).toBe(true)
    expect(historyAlert(container)).toBeNull()
    expect(buttonNamed(container, "Run comparison")!.disabled).toBe(false)
  })
})
