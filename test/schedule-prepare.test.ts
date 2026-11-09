import { afterEach, describe, expect, it, vi } from "vitest"
import { announceCommunityChoice, prepareScheduledCoverage, scheduledCoverage } from "../src/main/backup/schedule-prepare"
import { BackupScheduler } from "../src/main/backup/scheduler"
import type { BackupSchedule } from "../src/shared/ipc"
import type { Plan } from "../src/shared/plans"
import { memoryStore } from "./helpers"

const schedule = (tenantId: string, frequency = "weekly", enabled = true) => ({ tenantId, frequency, enabled, time: "23:59", since: new Date().toISOString(), attempts: 0, nextRunAt: null }) as BackupSchedule

afterEach(() => vi.useRealTimers())

describe("scheduled coverage preparation", () => {
  it("waits for an unchecked tenant's slot while rechecking Community daily schedules", async () => {
    vi.useFakeTimers()
    const license = { plan: (id: string) => id === "unchecked" ? null : id.startsWith("community") ? "community" as const : "pro" as const, requireEntitlement: vi.fn(async (_id: string) => "community") }
    let due = false
    const scheduler = { list: () => [schedule("unchecked"), schedule("community-daily", "daily"), schedule("community-weekly"), schedule("pro", "daily"), schedule("disabled", "daily", false)], isDue: () => due }
    const prepare = prepareScheduledCoverage(license)
    await prepare(scheduler)
    expect(license.requireEntitlement.mock.calls.map(([id]) => id)).toEqual(["community-daily"])
    due = true
    await prepare(scheduler)
    expect(license.requireEntitlement.mock.calls.map(([id]) => id)).toEqual(["community-daily", "unchecked", "community-daily"])
  })

  it("does not check a never-due tenant across many ticks, then checks once when due", async () => {
    vi.useFakeTimers()
    const requireEntitlement = vi.fn(async () => undefined)
    const prepare = prepareScheduledCoverage({ plan: () => null, requireEntitlement })
    let due = false
    const isDue = vi.fn((entry: BackupSchedule) => { expect(entry.pausedReason).toBeUndefined(); return due })
    const scheduler = { list: () => [{ ...schedule("contoso"), pausedReason: "Paused: choose a Community tenant or add a license" }], isDue }
    for (let tick = 0; tick < 480; tick++) {
      await prepare(scheduler)
      vi.advanceTimersByTime(60_000)
    }
    expect(requireEntitlement).not.toHaveBeenCalled()
    due = true
    await prepare(scheduler)
    await prepare(scheduler)
    expect(requireEntitlement).toHaveBeenCalledExactlyOnceWith("contoso")
  })

  it("bounds outage checks to the recheck interval and continues with other tenants", async () => {
    vi.useFakeTimers()
    const requireEntitlement = vi.fn(async () => { throw new Error("Unavailable") })
    const prepare = prepareScheduledCoverage({ plan: () => null, requireEntitlement })
    const scheduler = { list: () => [schedule("contoso"), schedule("fabrikam")], isDue: () => true }
    await prepare(scheduler)
    for (let tick = 0; tick < 359; tick++) {
      vi.advanceTimersByTime(60_000)
      await prepare(scheduler)
    }
    expect(requireEntitlement).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000)
    await prepare({ ...scheduler, isDue: () => false })
    expect(requireEntitlement).toHaveBeenCalledTimes(4)
  })

  it("announces pending choice once across restarts and again only on a new transition", () => {
    const store = memoryStore()
    const notify = vi.fn()
    announceCommunityChoice(store, false, notify)
    announceCommunityChoice(store, true, notify)
    announceCommunityChoice(store, true, notify)
    expect(notify).toHaveBeenCalledTimes(1)
    announceCommunityChoice(store, false, notify)
    announceCommunityChoice(store, true, notify)
    expect(notify).toHaveBeenCalledTimes(2)
  })
})

it("leaves the stored Azure pause and notice markers untouched while the profile is unknown", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 8, 12))
  const store = memoryStore()
  let plan: Plan = "pro"
  let profile: { storageAccountName: string } | null = { storageAccountName: "stcontoso" }
  const license = { plan: () => plan, coverageEndedAt: () => new Date(2026, 10, 9, 1).getTime(), communityPendingTenants: () => [] }
  const notice = vi.fn()
  const pause = vi.fn()
  const run = vi.fn(async () => ({ status: "Completed" as const, message: "Done" }))
  const scheduler = new BackupScheduler(store, run, undefined, undefined, (id) => scheduledCoverage(license, id, profile), undefined, notice, pause)
  scheduler.set({ tenantId: "contoso", enabled: true, frequency: "daily", time: "02:00" })
  plan = "community"
  vi.setSystemTime(new Date(2026, 10, 9, 3))
  expect(scheduler.list()[0]?.azurePauseNotified).toBe(true)
  const stored = store.get("backup.schedules")
  profile = null
  expect(scheduledCoverage(license, "contoso", profile)).toBeUndefined()
  expect(scheduler.list()[0]?.pausedReason).toBe("Paused: Azure storage needs Pro")
  await scheduler.tick()
  expect(store.get("backup.schedules")).toBe(stored)
  expect(run).not.toHaveBeenCalled()
  expect(notice).not.toHaveBeenCalled()
  expect(pause).toHaveBeenCalledTimes(1)
  expect(scheduledCoverage(license, "contoso", { storageAccountName: "tvlocal-contoso" })?.azure).toBe(false)
  expect(scheduledCoverage(license, "contoso", { storageAccountName: "stcontoso" })?.azure).toBe(true)
})
