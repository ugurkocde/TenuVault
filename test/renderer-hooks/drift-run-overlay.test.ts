import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DriftJob, SavedDriftResult } from "../../src/renderer/lib/drift-jobs"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tenant = vi.hoisted(() => ({ id: "11111111-1111-1111-1111-111111111111" }))

const driftStore = vi.hoisted(() => ({
  job: undefined as DriftJob | undefined,
  result: null as SavedDriftResult | null,
  results: {} as Record<string, SavedDriftResult | null>,
  listeners: new Set<() => void>(),
  finishListeners: new Set<(job: DriftJob, loaded: boolean) => void>(),
  cancel: vi.fn(),
  loadResult: vi.fn(async (): Promise<boolean> => true),
  emit() { for (const listener of this.listeners) listener() },
  setJob(job: DriftJob | undefined) { this.job = job; this.emit() },
  setResult(result: SavedDriftResult | null) {
    this.result = result
    this.results = { ...this.results, [result?.tenantId ?? tenant.id]: result }
    this.emit()
  },
  finish(job: DriftJob, loaded = true) { for (const listener of this.finishListeners) listener(job, loaded) },
}))

vi.mock("../../src/renderer/lib/drift-jobs", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  const subscribe = (listener: () => void) => { driftStore.listeners.add(listener); return () => void driftStore.listeners.delete(listener) }
  return {
    useDriftJob: () => React.useSyncExternalStore(subscribe, () => driftStore.job),
    useDriftResult: (tenantId: string | undefined) => {
      const results = React.useSyncExternalStore(subscribe, () => driftStore.results)
      if (!tenantId) return { result: null, loaded: true }
      return { result: results[tenantId.toLowerCase()] ?? null, loaded: tenantId.toLowerCase() in results }
    },
    startDriftScan: async (tenantId: string) => {
      const job: DriftJob = {
        jobId: `job-${tenantId}`, tenantId: tenantId.toLowerCase(), status: "running", phase: "comparing",
        detail: "Comparing policies: 4 of 10", done: 4, total: 10, percent: 44,
        startedAt: new Date().toISOString(), baseline: null, comparison: null,
      }
      driftStore.setJob(job)
      return job
    },
    cancelDriftScan: async (job: DriftJob) => {
      driftStore.cancel(job)
      driftStore.setJob({ ...job, status: "cancelled", finishedAt: new Date().toISOString() })
    },
    loadDriftResult: driftStore.loadResult,
    onDriftScanFinished: (listener: (job: DriftJob, loaded: boolean) => void) => {
      driftStore.finishListeners.add(listener)
      return () => void driftStore.finishListeners.delete(listener)
    },
  }
})
// Stable references, like the real contexts: a new object per render would re-run the
// page's tenant-change effect forever.
const tenantCache = vi.hoisted(() => new Map<string, unknown>())
vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useTenants: () => [],
  useSelectedTenant: () => {
    if (!tenantCache.has(tenant.id)) tenantCache.set(tenant.id, {
      selectedTenant: {
        id: "local", name: "Synthetic tenant",
        credentials: { tenantId: tenant.id, appId: "22222222-2222-2222-2222-222222222222" },
        resources: { storageAccountName: "tvlocal-synthetic" },
      },
      setSelectedTenantId: () => undefined,
    })
    return tenantCache.get(tenant.id)
  },
}))
vi.mock("../../src/renderer/lib/license", () => ({ useTenantPlan: () => "pro" }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { license: { open: async () => undefined } } }))
vi.mock("../../src/renderer/lib/plan-dialog", () => ({ showFeaturePlanError: () => undefined }))
const backupList = vi.hoisted(() => ({
  backups: [
    { id: "backup-new", status: "completed", timestamp: "2026-10-17T10:00:00.000Z" },
    { id: "backup-old", status: "completed", timestamp: "2026-10-16T10:00:00.000Z" },
  ],
  loading: false, error: "",
}))
vi.mock("../../src/renderer/lib/backup-list", () => ({
  useBackupList: () => backupList,
  refreshBackupList: async () => undefined,
}))
vi.mock("../../src/renderer/lib/backups", () => ({
  backupTarget: () => null,
  trackBackup: () => undefined,
  whenBackupEnds: () => undefined,
}))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))
vi.mock("../../src/renderer/components/RunBackupDialog", () => ({ RunBackupDialog: () => null }))
vi.mock("../../src/portal/components/drift/revert-progress-modal", () => ({ RevertProgressModal: () => null }))
vi.mock("../../src/portal/components/drift/backup-pair-picker", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  return {
    BackupPairPicker: (props: { busy?: boolean; onCompare?: () => void }) =>
      React.createElement("button", { type: "button", id: "compare-button", disabled: props.busy, onClick: props.onCompare }, "Compare"),
  }
})
vi.mock("../../src/portal/contexts/BackupProgressContext", () => ({
  useBackupProgress: () => ({ addJob: () => undefined }),
}))

import DriftDetectionPage from "../../src/portal/app/portal/drift/page"

function savedResult(jobId: string): SavedDriftResult {
  return {
    schemaVersion: 1, tenantId: tenant.id, jobId, storageAccountName: "tvlocal-synthetic",
    drifts: [], lastScan: "2026-10-17T10:05:00.000Z", backupsAnalyzed: 2,
    baseline: { id: "backup-old", timestamp: "2026-10-16T10:00:00.000Z" },
    comparison: { id: "backup-new", timestamp: "2026-10-17T10:00:00.000Z" },
    warnings: [], stats: { compared: 0, unchanged: 10 },
  } as unknown as SavedDriftResult
}

const roots: Root[] = []
const containers: HTMLDivElement[] = []

function render(): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  let root: Root
  act(() => {
    root = createRoot(container)
    roots.push(root)
    root.render(createElement(MemoryRouter, null, createElement(DriftDetectionPage)))
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

function overlay(container: HTMLDivElement): HTMLElement | null {
  return container.querySelector('[aria-label="Drift scan in progress"]')
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  driftStore.job = undefined
  driftStore.result = null
  driftStore.results = {}
  driftStore.cancel.mockClear()
  driftStore.loadResult.mockReset()
  driftStore.loadResult.mockImplementation(async () => true)
})

describe("DriftDetectionPage run overlay", () => {
  it("shows the auto-started first scan as an overlay without taking focus, then reveals its result", async () => {
    tenant.id = "11111111-1111-1111-1111-111111111111"
    driftStore.results = { [tenant.id]: null }
    const container = render()
    await flush()
    const view = overlay(container)
    expect(view?.className).toContain("fixed")
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("44")
    expect(view?.textContent).toContain("Comparing policies: 4 of 10")
    // The page opened the scan by itself, so focus stays where it was.
    expect(document.activeElement).not.toBe(view)
    // The picker stays mounted underneath.
    expect(container.querySelector("#compare-button")).not.toBeNull()

    const running = driftStore.job!
    const completed: DriftJob = { ...running, status: "completed", phase: "history", percent: 100, finishedAt: new Date().toISOString() }
    act(() => driftStore.setJob(completed))
    // The overlay holds at 100 percent until the saved result of this job is on screen.
    expect(overlay(container)).not.toBeNull()
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100")
    act(() => {
      driftStore.setResult(savedResult(completed.jobId))
      driftStore.finish(completed)
    })
    await flush()
    expect(overlay(container)).toBeNull()
    expect(container.querySelector("#drift-results-summary")?.className).toContain("run-results-reveal")
  })

  it("captures focus for a Compare-started re-scan, cancels from the overlay and keeps the previous result", async () => {
    tenant.id = "33333333-3333-3333-3333-333333333333"
    driftStore.results = { [tenant.id]: savedResult("job-previous") }
    const container = render()
    await flush()
    expect(container.querySelector("#drift-results-summary")?.className).not.toContain("run-results-reveal")
    const compare = container.querySelector<HTMLElement>("#compare-button")!
    act(() => compare.focus())
    await act(async () => { compare.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    await flush()
    const view = overlay(container)
    expect(view).not.toBeNull()
    expect(document.activeElement).toBe(view)
    expect(view?.textContent).toContain("Your previous result is kept if this scan does not finish.")

    const cancel = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Cancel scan"))!
    await act(async () => { cancel.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    await flush()
    expect(driftStore.cancel).toHaveBeenCalledTimes(1)
    expect(overlay(container)).toBeNull()
    expect(document.activeElement).toBe(compare)
    // The previous result is still the one on screen.
    expect(container.querySelector("#drift-results-summary")).not.toBeNull()
  })

  it("gates completion and reveals when the page mounted into an already running scan", async () => {
    tenant.id = "55555555-5555-5555-5555-555555555555"
    driftStore.results = { [tenant.id]: savedResult("job-previous") }
    driftStore.job = {
      jobId: "job-running", tenantId: tenant.id, status: "running", phase: "comparing",
      detail: "Comparing policies: 4 of 10", done: 4, total: 10, percent: 44,
      startedAt: new Date().toISOString(), baseline: null, comparison: null,
    }
    const container = render()
    await flush()
    expect(overlay(container)).not.toBeNull()
    const completed: DriftJob = { ...driftStore.job, status: "completed", phase: "history", percent: 100, finishedAt: new Date().toISOString() }
    act(() => driftStore.setJob(completed))
    // Still held: the result of this job is not on screen yet.
    expect(overlay(container)).not.toBeNull()
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100")
    act(() => {
      driftStore.setResult(savedResult(completed.jobId))
      driftStore.finish(completed)
    })
    await flush()
    expect(overlay(container)).toBeNull()
    expect(container.querySelector("#drift-results-summary")?.className).toContain("run-results-reveal")
  })

  it("names the previous result and offers a retry when the finished result cannot be loaded", async () => {
    tenant.id = "66666666-6666-6666-6666-666666666666"
    driftStore.results = { [tenant.id]: savedResult("job-previous") }
    const container = render()
    await flush()
    const compare = container.querySelector<HTMLElement>("#compare-button")!
    await act(async () => { compare.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    await flush()
    expect(overlay(container)).not.toBeNull()
    const completed: DriftJob = { ...driftStore.job!, status: "completed", percent: 100, finishedAt: new Date().toISOString() }
    act(() => {
      driftStore.setJob(completed)
      driftStore.finish(completed, false)
    })
    await flush()
    expect(overlay(container)).toBeNull()
    expect(container.textContent).toContain("its result could not be loaded")
    expect(container.textContent).toContain("The result below is from an earlier scan.")
    expect(container.querySelector("#drift-results-summary")).not.toBeNull()
    expect(container.querySelector("#drift-results-summary")?.className).not.toContain("run-results-reveal")

    driftStore.loadResult.mockImplementation(async () => {
      driftStore.setResult(savedResult(completed.jobId))
      return true
    })
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry")!
    await act(async () => { retry.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    await flush()
    expect(container.textContent).not.toContain("its result could not be loaded")
    expect(container.querySelector("#drift-results-summary")?.className).toContain("run-results-reveal")
  })

  it("lifts at once onto the previous result and the failure notice when a scan fails", async () => {
    tenant.id = "77777777-7777-7777-7777-777777777777"
    driftStore.results = { [tenant.id]: savedResult("job-previous") }
    const container = render()
    await flush()
    const compare = container.querySelector<HTMLElement>("#compare-button")!
    await act(async () => { compare.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    await flush()
    expect(overlay(container)).not.toBeNull()
    act(() => driftStore.setJob({ ...driftStore.job!, status: "failed", error: "Storage could not be read.", finishedAt: "2026-10-17T12:00:00.000Z" }))
    await flush()
    expect(overlay(container)).toBeNull()
    expect(container.textContent).toContain("The last drift scan failed.")
    expect(container.querySelector("#drift-results-summary")).not.toBeNull()
  })

  it("opens on a saved result with no overlay and no reveal", async () => {
    tenant.id = "44444444-4444-4444-4444-444444444444"
    driftStore.results = { [tenant.id]: savedResult("job-saved") }
    const container = render()
    await flush()
    expect(overlay(container)).toBeNull()
    expect(container.querySelector("#drift-results-summary")?.className).not.toContain("run-results-reveal")
  })
})
