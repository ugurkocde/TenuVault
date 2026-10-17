import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createBackgroundTaskStore, isOnTaskPage, type BackgroundTask } from "../src/renderer/lib/background-task-store"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function deferred<T>() {
  let resolve = (_value: T) => {}
  let reject = (_error: unknown) => {}
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeStore(hash = "#/portal/dashboard", currentTenantId?: string) {
  const notified: BackgroundTask[] = []
  const store = createBackgroundTaskStore({
    notify: (task) => notified.push(task),
    currentHash: () => hash,
    currentTenantId: () => currentTenantId,
    autoRemoveMs: 30_000,
  })
  return { store, notified }
}

it("recognizes the task result page in the hash route", () => {
  expect(isOnTaskPage("#/portal/drift", "/portal/drift")).toBe(true)
  expect(isOnTaskPage("#/portal/drift?tenant=abc", "/portal/drift")).toBe(true)
  expect(isOnTaskPage("#/portal/frameworks/cis-benchmarks", "/portal/frameworks")).toBe(true)
  expect(isOnTaskPage("#/portal/drift", "/portal/backup")).toBe(false)
  expect(isOnTaskPage("#/portal/drift", undefined)).toBe(false)
})

it("tracks a task from running to completed and notifies away from its page", async () => {
  const { store, notified } = makeStore()
  const work = deferred<string>()
  expect(store.start("scan:1", { title: "Hygiene scan", href: "/portal/governance/hygiene" }, () => work.promise)).toBe(true)
  expect(store.getSnapshot()).toMatchObject([{ id: "scan:1", status: "running", title: "Hygiene scan" }])
  work.resolve("Hygiene scan finished.")
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot()).toMatchObject([{ id: "scan:1", status: "completed", detail: "Hygiene scan finished.", percent: 100 }])
  expect(notified).toMatchObject([{ id: "scan:1", status: "completed" }])
  // A completed task leaves the list on its own.
  await vi.advanceTimersByTimeAsync(30_000)
  expect(store.getSnapshot()).toEqual([])
})

it("does not notify when the result page is already open", async () => {
  const { store, notified } = makeStore("#/portal/governance/hygiene")
  store.start("scan:1", { title: "Hygiene scan", href: "/portal/governance/hygiene" }, async () => "done")
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot()[0]!.status).toBe("completed")
  expect(notified).toEqual([])
})

it("still notifies on the result page of a different tenant", async () => {
  const other = makeStore("#/portal/governance/hygiene", "tenant-b")
  other.store.start("scan:a", { title: "Hygiene scan", href: "/portal/governance/hygiene", tenantId: "tenant-a" }, async () => "done")
  await vi.advanceTimersByTimeAsync(0)
  expect(other.notified).toHaveLength(1)
  const same = makeStore("#/portal/governance/hygiene", "tenant-a")
  same.store.start("scan:a", { title: "Hygiene scan", href: "/portal/governance/hygiene", tenantId: "tenant-a" }, async () => "done")
  await vi.advanceTimersByTimeAsync(0)
  expect(same.notified).toEqual([])
})

it("ignores a second start of a running key and accepts it again after the finish", async () => {
  const { store } = makeStore()
  const work = deferred<string>()
  const second = vi.fn(async () => "second")
  expect(store.start("scan:1", { title: "Scan" }, () => work.promise)).toBe(true)
  expect(store.start("scan:1", { title: "Scan" }, second)).toBe(false)
  expect(second).not.toHaveBeenCalled()
  work.resolve("first")
  await vi.advanceTimersByTimeAsync(0)
  expect(store.start("scan:1", { title: "Scan" }, second)).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot()).toMatchObject([{ id: "scan:1", status: "completed", detail: "second" }])
})

it("keeps a restarted task listed when the first run's auto-remove time passes", async () => {
  const { store, notified } = makeStore()
  store.start("export:1", { title: "Export" }, async () => "first")
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot()).toMatchObject([{ id: "export:1", status: "completed" }])
  const second = deferred<string>()
  expect(store.start("export:1", { title: "Export" }, () => second.promise)).toBe(true)
  // The first run's 30 second auto-remove must not delete the restarted task mid-run.
  await vi.advanceTimersByTimeAsync(30_000)
  expect(store.getSnapshot()).toMatchObject([{ id: "export:1", status: "running" }])
  second.resolve("second")
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot()).toMatchObject([{ id: "export:1", status: "completed", detail: "second" }])
  expect(notified.map((task) => task.detail)).toEqual(["first", "second"])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(store.getSnapshot()).toEqual([])
})

it("applies progress reports while running", async () => {
  const { store } = makeStore()
  const work = deferred<string>()
  store.start("export:1", { title: "Export" }, (report) => {
    report({ detail: "Building the PDF", percent: 40 })
    return work.promise
  })
  expect(store.getSnapshot()[0]).toMatchObject({ detail: "Building the PDF", percent: 40, status: "running" })
  work.resolve("Export downloaded.")
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot()[0]).toMatchObject({ status: "completed", detail: "Export downloaded.", percent: 100 })
})

it("keeps a failed task listed with its error until dismissed", async () => {
  const { store, notified } = makeStore()
  store.start("review:1", { title: "Health review", href: "/portal/operations/health-review" }, async () => { throw new Error("Tenant unreachable.") })
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot()).toMatchObject([{ id: "review:1", status: "failed", error: "Tenant unreachable." }])
  expect(notified).toMatchObject([{ id: "review:1", status: "failed" }])
  await vi.advanceTimersByTimeAsync(120_000)
  expect(store.getSnapshot()).toHaveLength(1)
  store.dismiss("review:1")
  expect(store.getSnapshot()).toEqual([])
})

it("clearFinished removes finished tasks but keeps running ones", async () => {
  const { store } = makeStore()
  const work = deferred<string>()
  store.start("a", { title: "A" }, async () => "done")
  store.start("b", { title: "B" }, () => work.promise)
  await vi.advanceTimersByTimeAsync(0)
  store.clearFinished()
  expect(store.getSnapshot().map((task) => task.id)).toEqual(["b"])
  work.resolve("done")
  await vi.advanceTimersByTimeAsync(0)
})
