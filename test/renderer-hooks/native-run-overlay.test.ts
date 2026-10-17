import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FrameworkJob } from "../../src/renderer/lib/framework-jobs"
import type { NativeAssessment } from "../../src/shared/compliance/native"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tenantId = "11111111-1111-1111-1111-111111111111"

const jobStore = vi.hoisted(() => ({
  job: undefined as FrameworkJob | undefined,
  listeners: new Set<() => void>(),
  emit() { for (const listener of this.listeners) listener() },
  set(job: FrameworkJob | undefined) { this.job = job; this.emit() },
  cancel: vi.fn(),
}))

vi.mock("../../src/renderer/lib/framework-jobs", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  return {
    useFrameworkJob: () => React.useSyncExternalStore(
      (listener: () => void) => { jobStore.listeners.add(listener); return () => void jobStore.listeners.delete(listener) },
      () => jobStore.job,
    ),
    startFrameworkJob: async () => { throw new Error("not used") },
    cancelFrameworkJob: jobStore.cancel,
  }
})
vi.mock("../../src/renderer/lib/background-tasks", () => ({
  startBackgroundTask: () => undefined,
  useBackgroundTasks: () => [],
}))
vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId: "22222222-2222-2222-2222-222222222222" } } }),
}))
vi.mock("../../src/renderer/lib/license", () => ({ useTenantPlan: () => "community" }))
vi.mock("../../src/portal/components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm: async () => true, confirmDialog: null }),
}))

import NativeFrameworkPage from "../../src/renderer/pages/NativeFrameworkPage"
import type { Framework } from "../../src/shared/frameworks/catalog"

const framework: Framework = {
  id: "synthetic-framework", name: "Synthetic Framework", publisher: "Synthetic", kind: "Control framework",
  description: "A synthetic framework for tests.", source: "https://example.com", coverage: "Synthetic coverage.", nativeId: "synthetic",
}

function nativeRun(runId: string): NativeAssessment {
  return {
    schemaVersion: 1, runId, tenantId, frameworkId: framework.id, sourceCommit: "source",
    snapshotSha256: "snapshot", rulesetSha256: "ruleset", licenseNotice: "",
    assessment: {
      schemaVersion: 1, generatedAt: "2026-10-17T10:00:00.000Z",
      provenance: { sourceCommit: "source", rulesetVersion: "1", snapshotSha256: "snapshot", rulesetSha256: "ruleset", collectorVersion: "1" },
      scope: { platforms: ["windows"], essentialEightMaturityLevel: 1, defStanRiskLevel: 1 },
      collectionCoverage: [], capabilities: [],
      frameworks: [{
        framework: { id: "synthetic", name: "Synthetic", version: "1.0", note: "Synthetic note." },
        summary: { totalControls: 0 }, controls: [],
      }],
    },
  } as unknown as NativeAssessment
}

function jobSummary(partial: Partial<FrameworkJob>): FrameworkJob {
  return {
    jobId: "job-1", tenantId, frameworkId: framework.id, frameworkName: framework.name,
    status: "running", step: "collecting", detail: "Reading device configurations (1 of 3): 4 of 10 policies",
    percent: 42, startedAt: new Date().toISOString(), ...partial,
  }
}

const roots: Root[] = []
const containers: HTMLDivElement[] = []
let history: NativeAssessment[] = []
let historyGate: Promise<void> | null = null
let releaseHistory: (() => void) | null = null
function holdHistory(): void {
  historyGate = new Promise<void>(resolve => { releaseHistory = resolve })
}

function render(): HTMLDivElement {
  vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action?: string }
    if (body.action === "native-info") return Response.json({ rights: { edition: "Synthetic", sourceContentLicense: "None", contentMode: "independent-reference", strategies: [] } })
    if (body.action === "native-history") { if (historyGate) await historyGate; return Response.json({ history, persistent: true, currentRunIds: history.map(run => run.runId) }) }
    return Response.json({})
  }))
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let root: Root
  act(() => {
    root = createRoot(container)
    roots.push(root)
    root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(NativeFrameworkPage, { framework }))))
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

function setJob(job: FrameworkJob | undefined): void {
  act(() => jobStore.set(job))
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  jobStore.job = undefined
  jobStore.cancel.mockClear()
  history = []
  historyGate = null
  releaseHistory = null
  vi.unstubAllGlobals()
})

describe("NativeFrameworkPage run overlay", () => {
  it("shows the running comparison as a full-page overlay and reveals the loaded result", async () => {
    const container = render()
    await flush()
    setJob(jobSummary({}))
    const view = container.querySelector('[aria-label="Comparison in progress"]')
    expect(view?.className).toContain("fixed")
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("42")
    expect(view?.textContent).toContain("Reading device configurations (1 of 3): 4 of 10 policies")
    expect(view?.textContent).toContain("elapsed")
    // The setup stays mounted underneath.
    expect(container.querySelector("#native-scope")).not.toBeNull()

    history = [nativeRun("run-1")]
    setJob(jobSummary({ status: "completed", step: "saving", percent: 97, runId: "run-1", finishedAt: new Date().toISOString() }))
    await flush()
    await flush()
    expect(container.querySelector('[aria-label="Comparison in progress"]')).toBeNull()
    const results = container.querySelector('[aria-labelledby="native-summary"]')
    expect(results?.className).toContain("run-results-reveal")
  })

  it("cancels from the overlay and lifts it at once when the comparison fails", async () => {
    const container = render()
    await flush()
    setJob(jobSummary({}))
    const cancel = [...container.querySelectorAll("button")].filter(button => button.textContent === "Cancel comparison")
    // One in the overlay, one inert in the scope card underneath.
    expect(cancel.length).toBeGreaterThanOrEqual(1)
    await act(async () => { cancel[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    await flush()
    expect(jobStore.cancel).toHaveBeenCalled()
    setJob(jobSummary({ status: "failed", percent: 42, error: "Read failed.", finishedAt: new Date().toISOString() }))
    expect(container.querySelector('[aria-label="Comparison in progress"]')).toBeNull()
    expect(container.textContent).toContain("The last comparison failed.")
  })

  it("keeps the same overlay mounted through a delayed completion after mounting mid-run, without stealing moved focus", async () => {
    history = [nativeRun("run-old")]
    jobStore.job = jobSummary({})
    const container = render()
    await flush()
    const view = container.querySelector('[aria-label="Comparison in progress"]')
    expect(view).not.toBeNull()
    expect(container.querySelector('[aria-labelledby="native-summary"]')).not.toBeNull()
    // Focus the admin moved away (here: a stand-in outside the page) must stay put.
    const outside = document.createElement("button")
    document.body.appendChild(outside)
    act(() => outside.focus())

    history = [nativeRun("run-1"), nativeRun("run-old")]
    holdHistory()
    setJob(jobSummary({ status: "completed", step: "saving", percent: 97, runId: "run-1", finishedAt: new Date().toISOString() }))
    await flush()
    // Same node, still up at 100 percent while the result loads, focus untouched.
    expect(container.querySelector('[aria-label="Comparison in progress"]')).toBe(view)
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100")
    expect(document.activeElement).toBe(outside)

    await act(async () => { releaseHistory?.() })
    await flush()
    await flush()
    expect(container.querySelector('[aria-label="Comparison in progress"]')).toBeNull()
    expect(container.querySelector('[aria-labelledby="native-summary"]')?.className).toContain("run-results-reveal")
    outside.remove()
  })

  it("keeps the previous results on screen when a re-run fails", async () => {
    history = [nativeRun("run-old")]
    const container = render()
    await flush()
    expect(container.querySelector('[aria-labelledby="native-summary"]')).not.toBeNull()
    setJob(jobSummary({}))
    expect(container.querySelector('[aria-label="Comparison in progress"]')).not.toBeNull()
    setJob(jobSummary({ status: "failed", error: "Read failed.", finishedAt: new Date().toISOString() }))
    await flush()
    expect(container.querySelector('[aria-label="Comparison in progress"]')).toBeNull()
    expect(container.querySelector('[aria-labelledby="native-summary"]')).not.toBeNull()
    expect(container.textContent).toContain("The last comparison failed.")
  })

  it("does not replay the reveal for a saved comparison opened later", async () => {
    history = [nativeRun("run-saved")]
    const container = render()
    await flush()
    expect(container.querySelector('[aria-label="Comparison in progress"]')).toBeNull()
    expect(container.querySelector('[aria-labelledby="native-summary"]')?.className).not.toContain("run-results-reveal")
  })
})
