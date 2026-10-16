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
/**
 * A local framework service. `answer` handles assessment actions; workspace actions use `state`.
 * workspace-open asks `answer` for "running-job" (a stub hook, not a request) to learn the running job, as main reads both together.
 */
function stubService(options: { history?: ReturnType<typeof assessment>[]; unreadable?: boolean; answer?: (body: Record<string, unknown>) => Answer }) {
  const state = { unreadable: !!options.unreadable, current: workspace(options.history ?? [saved]) }
  const actions: Record<string, unknown>[] = []
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== "/api/frameworks") return Response.json({ deployments: [] })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    actions.push(body)
    if (body.action === "workspace-delete") { state.unreadable = false; state.current = { ...workspace([]), policies: [], reference: "" }; return Response.json(state.current) }
    if (body.action === "workspace-open" && !state.unreadable) {
      const job = options.answer?.({ ...body, action: "running-job" }) ?? { body: { jobId: null } }
      if ((job.status ?? 200) >= 400) return Response.json(job.body, { status: job.status })
      const found = job.body as { jobId?: string | null }
      return Response.json({ workspace: state.current, activeJob: found.jobId ? found : null })
    }
    if (String(body.action).startsWith("workspace-")) return state.unreadable ? Response.json({ error: WORKSPACE_UNREADABLE_MESSAGE }, { status: 400 }) : Response.json(state.current)
    const result = options.answer?.(body) ?? (body.action === "running-job" ? { body: { jobId: null } } : { status: 500, body: { error: "unexpected" } })
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
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => { if (String(init?.body).includes("workspace-open")) await gate; return answer(path, init) }))
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
      if (body.action === "running-job") return { body: { jobId: "job-1", reference, policies: [policy] } }
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
      if (body.action === "running-job") return { body: { jobId: null } }
      if (body.action === "assess-start") return { body: { jobId: "job-1" } }
      if (body.action === "assess-status") { polls += 1; return { body: polls === 1 ? snapshot("reading") : snapshot("failed", { error: "Request failed (502) at /beta/deviceManagement/configurationPolicies." }) } }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const { container } = render()
    await flush()
    expect(buttonNamed(container, "Run comparison again")).toBeUndefined()
    expect([...container.querySelectorAll("button")].filter(item => item.textContent === "Run again")).toHaveLength(1)
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
      if (body.action === "running-job") return { body: { jobId: null } }
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
      if (body.action === "running-job") return { body: { jobId: null } }
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
      if (body.action === "running-job") return { body: { jobId: null } }
      if (body.action === "assess-start") return { body: { jobId: "job-1" } }
      if (body.action === "assess-status") return { body: snapshot("done", { assessment: fresh }) }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const answer = globalThis.fetch as unknown as (path: string, init?: RequestInit) => Promise<Response>
    // Opening succeeds; the refresh after the run fails.
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (String(init?.body).includes('"workspace-load"')) return Response.json({ error: "Storage is busy." }, { status: 500 })
      return answer(path, init)
    }))
    const { container } = render()
    await flush()
    await act(async () => { buttonNamed(container, "Run again")!.click() })
    await waitFor(() => container.textContent.includes("could not be refreshed"))
    expect(levelSummary(container)).toContain("100%")
  })
})

describe("opening the page around a running assessment", () => {
  const jobPack = { jobId: "job-1", reference, policies: [policy] }

  it("opens with one workspace-open call that answers the workspace and the running job together", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const { state, actions } = stubService({ history: [], answer: body => {
      // The job saved its results and finished while main read the workspace.
      if (body.action === "running-job") { state.current = workspace([fresh]); return { body: { jobId: null } } }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const { container } = render()
    await flush()
    expect(actions.filter(body => body.action === "workspace-open")).toHaveLength(1)
    expect(actions.some(body => body.action === "workspace-load" || body.action === "running-job")).toBe(false)
    expect(results(container)).not.toBeNull()
    expect(levelSummary(container)).toContain("100%")
  })

  it("retries a failed running-job lookup and then follows the run", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    let lookups = 0
    stubService({ history: [], answer: body => {
      if (body.action === "running-job") return ++lookups === 1 ? { status: 503, body: { error: "Busy." } } : { body: jobPack }
      if (body.action === "assess-status") return { body: snapshot("reading") }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const { container } = render()
    await waitFor(() => container.textContent.includes("Reading tenant policies"))
    expect(lookups).toBe(2)
    expect(container.textContent).not.toContain("Could not check for a running assessment")
  })

  it("says so with Retry when the running-job lookup fails, instead of showing setup silently", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    let lookups = 0
    stubService({ history: [], answer: body => {
      if (body.action === "running-job") return ++lookups === 1 ? { status: 404, body: { error: "Not found." } } : { body: jobPack }
      if (body.action === "assess-status") return { body: snapshot("reading") }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const { container } = render()
    await flush()
    const notice = [...container.querySelectorAll('[role="alert"]')].find(item => item.textContent?.includes("Could not check for a running assessment"))
    expect(notice).toBeDefined()
    await act(async () => { buttonNamed(notice as HTMLElement, "Retry")!.click() })
    await waitFor(() => container.textContent.includes("Reading tenant policies"))
    expect(container.textContent).not.toContain("Could not check for a running assessment")
  })

  it("shows Connecting, not 0 of 0 policies read, before the tenant policy list arrives", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    stubService({ history: [], answer: body => {
      if (body.action === "running-job") return { body: jobPack }
      if (body.action === "assess-status") return { body: { ...snapshot("reading"), read: 0, total: 0 } }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const { container } = render()
    await waitFor(() => container.textContent.includes("Connecting to the tenant"))
    expect(container.textContent).not.toContain("0 of 0 policies read")
  })

  it("applies a followed run to the pack of that run, not to a different pack in the workspace", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const otherReference = "other-os 1.0.0 Level 1"
    const other = { ...assessment("run-other", "Present", "2026-10-16T11:00:00Z"), reference: otherReference }
    let polls = 0
    const { state } = stubService({ answer: body => {
      if (body.action === "running-job") return { body: { jobId: "job-1", reference: otherReference, policies: [policy] } }
      if (body.action === "assess-status") { polls += 1; return { body: polls === 1 ? snapshot("reading") : snapshot("done", { assessment: other }) } }
      return { status: 500, body: { error: "unexpected" } }
    } })
    state.current = { ...state.current, reference: "synthetic-os 9.9.9 Level 1" }
    const { container } = render()
    await waitFor(() => levelSummary(container).includes("100%"))
    expect(container.textContent).not.toContain("different policy pack")
  })
})

describe("checking again for a running assessment", () => {
  it("does not let a late Retry replace a fresh run's results or keep its selection on saved results", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const newer = assessment("run-fresh", "Missing", "2026-10-16T10:00:00Z")
    let opens = 0
    let releaseRetry!: () => void
    const retryGate = new Promise<void>(resolve => { releaseRetry = resolve })
    const { actions } = stubService({ answer: body => {
      if (body.action === "running-job") return ++opens === 1 ? { status: 404, body: { error: "Not found." } } : { body: { jobId: null } }
      if (body.action === "assess-start") return { body: { jobId: "job-1" } }
      if (body.action === "assess-status") return { body: snapshot("done", { assessment: newer }) }
      return { status: 500, body: { error: "unexpected" } }
    } })
    const answer = globalThis.fetch as unknown as (path: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (String(init?.body).includes('"workspace-open"') && opens >= 1) await retryGate
      return answer(path, init)
    }))
    const { container } = render()
    await flush()
    const notice = [...container.querySelectorAll('[role="alert"]')].find(item => item.textContent?.includes("Could not check for a running assessment"))
    expect(notice).toBeDefined()
    // Retry is still waiting for main when a fresh run finishes and a finding is selected.
    await act(async () => { buttonNamed(notice as HTMLElement, "Retry")!.click() })
    await act(async () => { buttonNamed(container, "Run again")!.click() })
    await waitFor(() => !container.textContent.includes("Showing a saved assessment") && !buttonNamed(container, "Re-running"))
    expect(container.textContent).not.toContain("Could not check for a running assessment")
    const box = container.querySelector<HTMLInputElement>('[aria-label="Assessment results"] input[type="checkbox"]')!
    expect(box.disabled).toBe(false)
    await act(async () => { box.click() })
    expect(box.checked).toBe(true)
    releaseRetry()
    await flush()
    // The saved assessment is older than the fresh results on screen, so it does not replace them.
    expect(container.textContent).not.toContain("Showing a saved assessment")
    expect(container.querySelector<HTMLInputElement>('[aria-label="Assessment results"] input[type="checkbox"]')!.checked).toBe(true)
    const plan = buttonNamed(container, "Plan remediation for 1 selected findings")
    expect(plan?.disabled).toBe(false)
    expect(actions.filter(body => body.action === "workspace-open").length).toBe(2)
  })
})

describe("saved results are read-only", () => {
  it("keeps remediation off in the panel itself, even with deviating findings selected", async () => {
    const { CisRemediationPanel } = await import("../../src/renderer/features/cis-remediation/CisRemediationPanel")
    const container = document.createElement("div")
    document.body.appendChild(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    const tenant = { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId: "22222222-2222-2222-2222-222222222222" } }
    act(() => { root.render(createElement(CisRemediationPanel, { tenant: tenant as never, assessment: saved as never, policies: [policy] as never, reference, selectedKeys: new Set(["0:0"]), onPlanned: () => undefined, readOnly: true })) })
    const buttons = [...container.querySelectorAll("button")]
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every(item => item.disabled)).toBe(true)
  })

  it("keeps exception removal off until a fresh run, and the remediation panel says to run again first", async () => {
    appInfo.mockResolvedValue({ internalCisBenchmarks: true })
    const { state, actions } = stubService({})
    state.current = { ...state.current, exceptions: [{ id: "exception-1", benchmark: "synthetic-os", version: "9.9.9", level: 1, policyName: "Synthetic policy", settingId: "synthetic_setting", owner: "Owner", reason: "Reason", expiresOn: "2099-01-01", createdAt: "2026-10-01T00:00:00Z" }] } as typeof state.current
    const { container } = render()
    await flush()
    const remove = [...container.querySelectorAll('[aria-label="CIS readiness"] button')].find(item => item.textContent === "Remove") as HTMLButtonElement | undefined
    expect(remove).toBeDefined()
    expect(remove!.disabled).toBe(true)
    await act(async () => { remove!.click() })
    await flush()
    expect(actions.some(body => body.action === "workspace-cis-exception-remove")).toBe(false)
    expect(container.querySelector('[aria-labelledby="cis-deploy-title"]')?.textContent).toContain("Run again first to get current evidence")
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
