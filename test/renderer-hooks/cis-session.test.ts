import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WORKSPACE_UNREADABLE_MESSAGE } from "../../src/shared/frameworks/workspace-history"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appInfo = vi.hoisted(() => vi.fn())
const confirmCalls = vi.hoisted(() => [] as { title: string; confirmLabel?: string; destructive?: boolean }[])
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
  useConfirm: () => ({ confirm: async (options: { title: string; confirmLabel?: string; destructive?: boolean }) => { confirmCalls.push(options); return true }, confirmDialog: null }),
}))

import FrameworksPage from "../../src/renderer/pages/FrameworksPage"
import { refreshInternalCisBenchmarks, resetInternalCisBenchmarks } from "../../src/renderer/lib/internal-cis"

const reference = "synthetic-os 9.9.9 Level 1"
const policy = { name: "Synthetic policy", platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark: "synthetic-os", version: "9.9.9", level: "Level 1", sourceFile: "synthetic.json" },
  settings: [{ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: "synthetic_setting", choiceSettingValue: { value: "synthetic_on", children: [] } } }] }
function assessment(runId: string, status: "Missing" | "Present", assessedAt: string) {
  return { runId, tenantId, frameworkId: "cis-benchmarks", reference, assessedAt, policyCount: 1,
    findings: [{ key: "0:0", policyIndex: 0, settingIndex: 0, policyName: "Synthetic policy", settingId: "synthetic_setting", status, recommended: policy.settings[0]!.settingInstance, observed: [] }] }
}
const saved = assessment("run-saved", "Missing", "2026-10-15T10:00:00Z")
const fresh = assessment("run-fresh", "Present", "2026-10-16T10:00:00Z")
function workspace(history: ReturnType<typeof assessment>[]) {
  return { version: 1, tenantId, frameworkId: "cis-benchmarks", policies: [policy], reference, updatedAt: "2026-10-15T10:00:00Z", history: history.map(item => ({ assessment: item, policies: [policy] })), capacity: { count: history.length, limit: 50, full: false, reason: null } }
}
function snapshot(phase: string, extra: object = {}) {
  return { jobId: "job-1", phase, status: phase, state: phase, tenantId, frameworkId: "cis-benchmarks", read: phase === "reading" ? 3 : 0, total: phase === "reading" ? 10 : 0, currentPolicy: "", comparedPolicies: 0, packPolicies: 1, currentPackPolicy: "", findings: [], nextSince: 0, error: null, assessment: null, ...extra }
}

type Answer = { status?: number; body: unknown }
/** A local framework service. `answer` handles assessment actions; workspace actions use `state`. */
function stubService(options: { history?: ReturnType<typeof assessment>[]; unreadable?: boolean; answer?: (body: Record<string, unknown>) => Answer }) {
  const state = { unreadable: !!options.unreadable, current: workspace(options.history ?? [saved]) }
  const actions: Record<string, unknown>[] = []
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== "/api/frameworks") return Response.json({ deployments: [] })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    actions.push(body)
    if (body.action === "workspace-delete") { state.unreadable = false; state.current = { ...workspace([]), policies: [], reference: "" }; return Response.json(state.current) }
    if (String(body.action).startsWith("workspace-")) return state.unreadable ? Response.json({ error: WORKSPACE_UNREADABLE_MESSAGE }, { status: 400 }) : Response.json(state.current)
    const result = options.answer?.(body) ?? (body.action === "assess-active" ? { body: { jobId: null } } : { status: 500, body: { error: "unexpected" } })
    return Response.json(result.body, { status: result.status ?? 200 })
  }))
  return { state, actions }
}

const roots: Root[] = []
const containers: HTMLDivElement[] = []
function render(path = "/portal/frameworks/cis-benchmarks"): { container: HTMLDivElement; navigate: (to: string) => void } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  const tree = (to: string) => createElement(MemoryRouter, { key: to, initialEntries: [to] }, createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) }), createElement(Route, { path: "/portal/dashboard", element: createElement("p", null, "Dashboard") })))
  act(() => { root.render(tree(path)) })
  return { container, navigate: to => act(() => { root.render(tree(to)) }) }
}
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error("Condition not met in time.")
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  }
}
const buttonNamed = (container: HTMLElement, name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name)
const results = (container: HTMLElement) => container.querySelector('[aria-label="Assessment results"]')
const levelSummary = (container: HTMLElement) => container.querySelector('[aria-label="Level 1 summary"]')?.textContent ?? ""

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  confirmCalls.splice(0)
  resetInternalCisBenchmarks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("CIS Benchmarks results across navigation", () => {
  it("opens on the newest saved assessment as current results, not the empty setup", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    stubService({})
    const { container } = render()
    await flush()
    expect(results(container)).not.toBeNull()
    expect(container.querySelector("#cis-delivered-title")).toBeNull()
    expect(levelSummary(container)).toContain("0%")
    // Saved results are read-only until a fresh run: nothing can be selected, excluded or remediated from them.
    expect(container.textContent).toContain("Showing a saved assessment. Run again to get current evidence")
    const boxes = [...container.querySelectorAll<HTMLInputElement>('[aria-label="Assessment results"] input[type="checkbox"]')]
    expect(boxes.length).toBeGreaterThan(0)
    expect(boxes.every(box => box.disabled)).toBe(true)
    expect(buttonNamed(container, "Select all deviating (1)")?.disabled).toBe(true)
    // Leave the page and come back: the results are shown again.
    const page = render("/portal/dashboard")
    await flush()
    page.navigate("/portal/frameworks/cis-benchmarks")
    await flush()
    expect(results(page.container)).not.toBeNull()
  })

  it("shows a loading state, not the empty setup, until the saved workspace has loaded", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    stubService({})
    const answer = globalThis.fetch as unknown as (path: string, init?: RequestInit) => Promise<Response>
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => { if (String(init?.body).includes("workspace-load")) await gate; return answer(path, init) }))
    const { container } = render()
    await flush()
    expect(container.textContent).toContain("Loading saved assessments")
    expect(container.querySelector("#cis-delivered-title")).toBeNull()
    expect(buttonNamed(container, "Start Assessment")).toBeUndefined()
    release()
    await flush()
    expect(results(container)).not.toBeNull()
    expect(container.textContent).not.toContain("Loading saved assessments")
  })

  it("waits for the first access answer after a reload instead of showing Coming soon", async () => {
    let answer!: (value: unknown) => void
    appInfo.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    stubService({})
    const { container } = render()
    await flush()
    expect(container.textContent).not.toContain("Coming soon")
    expect(container.textContent).toContain("Checking access")
    await act(async () => { answer({ internalCisBenchmarks: true }) })
    await flush()
    expect(results(container)).not.toBeNull()
  })

  it("offers Retry when the first access read fails instead of loading forever", async () => {
    appInfo.mockRejectedValue(new Error("bridge unavailable"))
    stubService({})
    const { container } = render()
    await flush()
    expect(container.textContent).toContain("CIS Benchmarks access could not be checked.")
    expect(container.textContent).not.toContain("Coming soon")
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    await act(async () => { buttonNamed(container, "Retry")!.click() })
    await flush()
    expect(results(container)).not.toBeNull()
  })

  it("opens on setup with the loaded pack when a different pack was loaded after the saved assessment", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const { state } = stubService({})
    state.current = { ...state.current, reference: "other-os 1.0.0 Level 1" }
    const { container } = render()
    await flush()
    expect(results(container)).toBeNull()
    expect(container.querySelector("#cis-delivered-title")).not.toBeNull()
  })

  it("follows an assessment still running for this tenant and shows its results when it finishes", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    let polls = 0
    const { actions } = stubService({ history: [], answer: body => {
      if (body.action === "assess-active") return { body: { jobId: "job-1" } }
      if (body.action === "assess-status") { polls += 1; return { body: polls === 1 ? snapshot("reading") : snapshot("done", { assessment: fresh }) } }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const { container } = render()
    await waitFor(() => container.textContent.includes("Reading tenant policies"))
    expect(container.textContent).toContain("3 of 10 policies read")
    expect(actions.some(body => body.action === "assess-start")).toBe(false)
    await waitFor(() => !!results(container))
    expect(levelSummary(container)).toContain("100%")
  })

  it("goes back to the results from setup through the Review results step", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    stubService({})
    const { container } = render()
    await flush()
    await act(async () => { buttonNamed(container, "New assessment")!.click() })
    expect(results(container)).toBeNull()
    const review = [...container.querySelectorAll('nav[aria-label="CIS Benchmarks progress"] button')].find(item => item.textContent?.includes("Review results"))
    expect(review).toBeDefined()
    await act(async () => { (review as HTMLButtonElement).click() })
    expect(results(container)).not.toBeNull()
  })

  it("keeps the CIS page mounted when access reads false mid-session", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    stubService({})
    const { container } = render()
    await flush()
    appInfo.mockResolvedValue({ internalCisBenchmarks: false })
    await act(async () => { await refreshInternalCisBenchmarks() })
    await flush()
    expect(container.textContent).not.toContain("Coming soon")
    expect(results(container)).not.toBeNull()
  })
})

describe("Run again", () => {
  it("keeps the previous results visible while re-running and after a failed re-run", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    let polls = 0
    const { actions } = stubService({ answer: body => {
      if (body.action === "assess-active") return { body: { jobId: null } }
      if (body.action === "assess-start") return { body: { jobId: "job-1" } }
      if (body.action === "assess-status") { polls += 1; return { body: polls === 1 ? snapshot("reading") : snapshot("failed", { error: "Request failed (502) at /beta/deviceManagement/configurationPolicies." }) } }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const { container } = render()
    await flush()
    expect(buttonNamed(container, "Run comparison again")).toBeUndefined()
    await act(async () => { buttonNamed(container, "Run again")!.click() })
    await waitFor(() => container.textContent.includes("Re-running assessment: reading tenant policies"))
    expect(results(container)).not.toBeNull()
    expect(levelSummary(container)).toContain("0%")
    expect(buttonNamed(container, "Re-running")?.disabled).toBe(true)
    await waitFor(() => container.textContent.includes("Request failed (502)"))
    expect(results(container)).not.toBeNull()
    expect(levelSummary(container)).toContain("0%")
    expect(container.textContent).not.toContain("Re-running assessment")
    expect(actions.filter(body => body.action === "assess").length).toBe(0)
  })

  it("replaces the previous results when the re-run completes", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    stubService({ answer: body => {
      if (body.action === "assess-active") return { body: { jobId: null } }
      if (body.action === "assess-start") return { body: { jobId: "job-1" } }
      if (body.action === "assess-status") return { body: snapshot("done", { assessment: fresh }) }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const { container } = render()
    await flush()
    await act(async () => { buttonNamed(container, "Run again")!.click() })
    await waitFor(() => levelSummary(container).includes("100%"))
    expect(results(container)).not.toBeNull()
    expect(container.textContent).not.toContain("Showing a saved assessment")
  })

  it("enables selection once a fresh run replaces the saved results", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const missing = assessment("run-fresh", "Missing", "2026-10-16T10:00:00Z")
    stubService({ answer: body => {
      if (body.action === "assess-active") return { body: { jobId: null } }
      if (body.action === "assess-start") return { body: { jobId: "job-1" } }
      if (body.action === "assess-status") return { body: snapshot("done", { assessment: missing }) }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const { container } = render()
    await flush()
    await act(async () => { buttonNamed(container, "Run again")!.click() })
    await waitFor(() => !container.textContent.includes("Showing a saved assessment"))
    const boxes = [...container.querySelectorAll<HTMLInputElement>('[aria-label="Assessment results"] input[type="checkbox"]')]
    expect(boxes.some(box => !box.disabled)).toBe(true)
  })

  it("says so when the saved list cannot be refreshed after a completed run", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    stubService({ answer: body => {
      if (body.action === "assess-active") return { body: { jobId: null } }
      if (body.action === "assess-start") return { body: { jobId: "job-1" } }
      if (body.action === "assess-status") return { body: snapshot("done", { assessment: fresh }) }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const answer = globalThis.fetch as unknown as (path: string, init?: RequestInit) => Promise<Response>
    let loads = 0
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (String(init?.body).includes("workspace-load") && ++loads > 1) return Response.json({ error: "Storage is busy." }, { status: 500 })
      return answer(path, init)
    }))
    const { container } = render()
    await flush()
    await act(async () => { buttonNamed(container, "Run again")!.click() })
    await waitFor(() => container.textContent.includes("could not be refreshed"))
    expect(levelSummary(container)).toContain("100%")
  })
})

describe("an unreadable saved workspace", () => {
  it("offers Reset workspace, and resetting leaves a working empty workspace", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const { actions } = stubService({ unreadable: true })
    const { container } = render()
    await flush()
    const notice = container.querySelector('[role="alert"][aria-label="Saved workspace cannot be read"]')
    expect(notice).not.toBeNull()
    await act(async () => { buttonNamed(notice as HTMLElement, "Reset workspace")!.click() })
    await flush()
    expect(confirmCalls[0]).toMatchObject({ title: "Reset workspace?", confirmLabel: "Reset workspace", destructive: true })
    expect(actions.some(body => body.action === "workspace-delete")).toBe(true)
    expect(container.querySelector('[aria-label="Saved workspace cannot be read"]')).toBeNull()
    expect(container.querySelector("#cis-delivered-title")).not.toBeNull()
    expect(container.querySelector('[aria-label="Saved assessment history"]')).not.toBeNull()
  })
})
