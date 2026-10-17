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

import { loadDriftResult, useDriftResult, type SavedDriftResult } from "../../src/renderer/lib/drift-jobs"

const tenantId = "99999999-9999-9999-9999-999999999999"

function result(jobId: string): SavedDriftResult {
  return { schemaVersion: 1, tenantId, jobId, storageAccountName: "tvlocal-synthetic" } as unknown as SavedDriftResult
}

const roots: Root[] = []
const containers: HTMLDivElement[] = []
let seen: SavedDriftResult | null = null

function Probe() {
  seen = useDriftResult(tenantId).result
  return null
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
    const container = document.createElement("div")
    document.body.appendChild(container)
    containers.push(container)
    let root: Root
    act(() => {
      root = createRoot(container)
      roots.push(root)
      root.render(createElement(MemoryRouter, null, createElement(Probe)))
    })

    // A slow Retry for the older scan starts first; the newer scan's read supersedes it.
    let staleRead: Promise<boolean> | undefined
    await act(async () => { staleRead = loadDriftResult(tenantId, true) })
    await act(async () => { await loadDriftResult(tenantId, true) })
    expect(seen?.jobId).toBe("job-new")

    await act(async () => { releaseFirst?.() })
    await expect(staleRead).resolves.toBe(false)
    expect(seen?.jobId).toBe("job-new")
  })
})
