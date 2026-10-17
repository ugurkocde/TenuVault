import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: null }),
  useTenants: () => [],
}))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))

import { loadDriftResult, refreshDriftJobs, useDriftResult, useDriftResultFailure, type DriftJob, type DriftResultLoad, type SavedDriftResult } from "../../src/renderer/lib/drift-jobs"

const tenantId = "99999999-9999-9999-9999-999999999999"
let probeTenant = tenantId

function result(jobId: string, tenant = probeTenant): SavedDriftResult {
  return { schemaVersion: 1, tenantId: tenant, jobId, storageAccountName: "tvlocal-synthetic" } as unknown as SavedDriftResult
}

function job(jobId: string, status: DriftJob["status"]): DriftJob {
  return {
    jobId, tenantId: probeTenant, status, phase: "comparing", detail: "Comparing",
    done: 1, total: 2, percent: status === "completed" ? 100 : 50,
    startedAt: new Date().toISOString(), baseline: null, comparison: null,
    ...(status === "completed" ? { finishedAt: new Date().toISOString() } : {}),
  }
}

const roots: Root[] = []
const containers: HTMLDivElement[] = []
let seen: SavedDriftResult | null = null

let failure: string | null = null
function Probe() {
  seen = useDriftResult(probeTenant).result
  failure = useDriftResultFailure(probeTenant)
  return null
}

function renderProbe(): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  let root: Root
  act(() => {
    root = createRoot(container)
    roots.push(root)
    root.render(createElement(MemoryRouter, null, createElement(Probe)))
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  vi.unstubAllGlobals()
})

describe("drift result store", () => {
  it("discards a superseded result read instead of overwriting the newer result", async () => {
    let releaseFirst: (() => void) | null = null
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve })
    let calls = 0
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { action?: string }
      if (body.action === "result") {
        calls += 1
        // The probe's mount load answers first; the held read is the explicit Retry after it.
        if (calls === 1) return Response.json({ result: null })
        if (calls === 2) { await firstHeld; return Response.json({ result: result("job-old") }) }
        return Response.json({ result: result("job-new") })
      }
      return Response.json({ jobs: [] })
    }))
    renderProbe()

    // A slow Retry for the older scan starts first; the newer scan's read supersedes it.
    let staleRead: Promise<DriftResultLoad> | undefined
    await act(async () => { staleRead = loadDriftResult(tenantId, true) })
    await act(async () => { await loadDriftResult(tenantId, true) })
    expect(seen?.jobId).toBe("job-new")

    await act(async () => { releaseFirst?.() })
    await expect(staleRead).resolves.toBe("superseded")
    expect(seen?.jobId).toBe("job-new")
  })

  it("records a completed scan whose result could not be read, and clears it when the result arrives", async () => {
    const running: DriftJob = {
      jobId: "job-fail", tenantId: probeTenant, status: "running", phase: "comparing", detail: "Comparing",
      done: 1, total: 2, percent: 50, startedAt: new Date().toISOString(), baseline: null, comparison: null,
    }
    let jobs: DriftJob[] = [running]
    let resultReadable = false
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { action?: string }
      if (body.action === "jobs") return Response.json({ jobs })
      if (body.action === "result") {
        if (!resultReadable) return new Response(JSON.stringify({ error: "Storage could not be read." }), { status: 500 })
        return Response.json({ result: result("job-fail") })
      }
      return Response.json({})
    }))
    renderProbe()
    await act(async () => { await refreshDriftJobs() })
    expect(failure).toBeNull()
    jobs = [{ ...running, status: "completed", percent: 100, finishedAt: new Date().toISOString() }]
    await act(async () => { await refreshDriftJobs() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(failure).toBe("job-fail")

    resultReadable = true
    await act(async () => { await expect(loadDriftResult(probeTenant, true)).resolves.toBe("loaded") })
    expect(seen?.jobId).toBe("job-fail")
    expect(failure).toBeNull()
  })
  it("keeps the newer scan's failure when an older superseded read rejects late", async () => {
    probeTenant = "88888888-8888-8888-8888-888888888888"
    let rejectHeld: (() => void) | null = null
    const held = new Promise<void>((_resolve, reject) => { rejectHeld = () => reject(new Error("read failed")) })
    let jobs: DriftJob[] = [job("job-old-held", "running")]
    let resultCalls = 0
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { action?: string }
      if (body.action === "jobs") return Response.json({ jobs })
      if (body.action === "result") {
        resultCalls += 1
        if (resultCalls === 1) return Response.json({ result: null })
        if (resultCalls === 2) { await held; return Response.json({ result: result("job-old-held") }) }
        return new Response(JSON.stringify({ error: "Storage could not be read." }), { status: 500 })
      }
      return Response.json({})
    }))
    renderProbe()
    await act(async () => { await refreshDriftJobs() })
    jobs = [job("job-old-held", "completed")]
    await act(async () => { await refreshDriftJobs() })
    // A newer scan runs and its own result read fails while the older read is still held.
    jobs = [job("job-new-fail", "running")]
    await act(async () => { await refreshDriftJobs() })
    jobs = [job("job-new-fail", "completed")]
    await act(async () => { await refreshDriftJobs() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(failure).toBe("job-new-fail")

    await act(async () => { rejectHeld?.() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(failure).toBe("job-new-fail")
  })

  it("does not recreate a failure when a superseded read rejects after a successful retry", async () => {
    probeTenant = "77777777-7777-7777-7777-777777777777"
    let rejectHeld: (() => void) | null = null
    const held = new Promise<void>((_resolve, reject) => { rejectHeld = () => reject(new Error("read failed")) })
    let jobs: DriftJob[] = [job("job-retry", "running")]
    let resultCalls = 0
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { action?: string }
      if (body.action === "jobs") return Response.json({ jobs })
      if (body.action === "result") {
        resultCalls += 1
        if (resultCalls === 1) return Response.json({ result: null })
        if (resultCalls === 2) { await held; return Response.json({ result: result("job-retry") }) }
        return Response.json({ result: result("job-retry") })
      }
      return Response.json({})
    }))
    renderProbe()
    await act(async () => { await refreshDriftJobs() })
    jobs = [job("job-retry", "completed")]
    await act(async () => { await refreshDriftJobs() })
    // The retry supersedes the held completion read and brings the result in.
    await act(async () => { await expect(loadDriftResult(probeTenant, true)).resolves.toBe("loaded") })
    expect(seen?.jobId).toBe("job-retry")
    expect(failure).toBeNull()

    await act(async () => { rejectHeld?.() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(seen?.jobId).toBe("job-retry")
    expect(failure).toBeNull()
  })
})
