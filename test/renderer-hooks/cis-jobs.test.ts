import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: undefined, selectedTenantId: undefined, setSelectedTenantId: () => undefined }),
}))

import { noteCisJobStarted, onCisJobFinished, refreshCisJobs, useCisJobs, type CisJob } from "../../src/renderer/lib/cis-jobs"

const job = {
  jobId: "cis-race-1",
  tenantId: "11111111-1111-1111-1111-111111111111",
  frameworkId: "cis-benchmarks",
  reference: "intune-windows11 5.0.0 Level 1",
  phase: "reading",
  status: "running",
  read: 1,
  total: 4,
  currentPolicy: "",
  comparedPolicies: 0,
  packPolicies: 2,
  currentPackPolicy: "",
  findingsCount: 0,
  error: null,
  runId: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
}

function Probe() {
  const jobs = useCisJobs()
  return createElement("p", null, jobs.map((item) => item.jobId).join(",") || "none")
}

const roots: Root[] = []
function mount(): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(createElement(Probe)) })
  return container
}
async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error("Condition not met in time.")
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }
}

describe("cis jobs store", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount())
    document.body.innerHTML = ""
    vi.unstubAllGlobals()
  })

  it("does not lose a just-started job when an older empty answer lands first", async () => {
    let call = 0
    const deferred: ((response: Response) => void)[] = []
    vi.stubGlobal("fetch", vi.fn(() => {
      call += 1
      if (call <= 2) return new Promise<Response>((resolve) => { deferred.push(resolve) })
      return Promise.resolve(Response.json({ jobs: [job] }))
    }))

    const container = mount()
    // The mount started the first read; an assessment starting now triggers a second one.
    await act(async () => { void refreshCisJobs() })
    expect(deferred).toHaveLength(2)
    // The older empty answer lands first and applies, then the answer holding the new job
    // is stale by revision and discarded. The store must read again instead of stopping.
    await act(async () => { deferred[0]!(Response.json({ jobs: [] })) })
    await act(async () => { deferred[1]!(Response.json({ jobs: [job] })) })
    await waitFor(() => container.textContent.includes("cis-race-1"))
  })

  it("keeps a noted started job across a failed refresh and announces its finish", async () => {
    const noted = { ...job, jobId: "cis-noted-1" } as CisJob
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    const finished: string[] = []
    const unsubscribe = onCisJobFinished((item) => finished.push(item.jobId))
    const container = mount()
    await act(async () => noteCisJobStarted(noted))
    await act(async () => { await refreshCisJobs() })
    expect(container.textContent).toContain("cis-noted-1")
    expect(finished).toEqual([])

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jobs: [{ ...noted, phase: "done", status: "done" }] })))
    await act(async () => { await refreshCisJobs() })
    expect(finished).toEqual(["cis-noted-1"])
    unsubscribe()
  })
})
