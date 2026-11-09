import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupScheduler } from "../src/main/backup/scheduler"
import type { Plan } from "../src/shared/plans"
import { memoryStore } from "./helpers"

afterEach(() => vi.useRealTimers())

describe("schedule downgrade", () => {
  it("keeps the saved daily schedule, runs the first slot after expiry weekly, and resumes daily", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 8, 12))
    const store = memoryStore()
    let plan: Plan = "pro"
    const run = vi.fn(async () => ({ status: "Completed" as const, message: "Done" }))
    const notice = vi.fn()
    const endedAt = new Date(2026, 10, 9, 1).getTime()
    const scheduler = new BackupScheduler(store, run, undefined, undefined, () => ({ plan, azure: false, endedAt }), undefined, notice)
    scheduler.set({ tenantId: "contoso", enabled: true, frequency: "daily", time: "02:00" })
    vi.setSystemTime(endedAt)
    plan = "community"
    const fallback = scheduler.list()[0]!
    expect(fallback.frequency).toBe("daily")
    expect(fallback.fallbackWeekday).toBe(1)
    expect(scheduler.isDue(fallback)).toBe(false)
    expect(notice).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date(2026, 10, 9, 2))
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
    for (let day = 10; day < 16; day++) {
      vi.setSystemTime(new Date(2026, 10, day, 2))
      await scheduler.tick()
    }
    expect(run).toHaveBeenCalledTimes(1)
    const restarted = new BackupScheduler(store, run, undefined, undefined, () => ({ plan, azure: false, endedAt }), undefined, notice)
    vi.setSystemTime(new Date(2026, 10, 16, 2))
    await restarted.tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(notice).toHaveBeenCalledTimes(1)
    const saved = restarted.list()[0]!
    restarted.set({ ...saved, enabled: false })
    expect(notice).toHaveBeenCalledTimes(1)
    restarted.set({ ...saved, enabled: true })
    expect(notice).toHaveBeenCalledTimes(1)
    plan = "pro"
    expect(restarted.list()[0]?.fallbackWeekday).toBeUndefined()
    vi.setSystemTime(new Date(2026, 10, 17, 2))
    await restarted.tick()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("pauses Azure without attempts, failures or runs, and resumes after changing to local weekly", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 8, 12))
    const store = memoryStore()
    let azure = true
    const run = vi.fn(async () => ({ status: "Completed" as const, message: "Done" }))
    const notice = vi.fn()
    const scheduler = new BackupScheduler(store, run, undefined, undefined, () => ({ plan: "community", azure }), undefined, notice)
    scheduler.set({ tenantId: "fabrikam", enabled: true, frequency: "daily", time: "02:00" })
    for (let day = 9; day < 20; day++) {
      vi.setSystemTime(new Date(2026, 10, day, 3))
      await scheduler.tick()
    }
    expect(run).not.toHaveBeenCalled()
    expect(notice).not.toHaveBeenCalled()
    expect(scheduler.list()[0]).toMatchObject({ pausedReason: "Paused: Azure storage needs Pro", attempts: 0, nextRunAt: null })
    expect(scheduler.list()[0]?.lastStatus).toBeUndefined()
    azure = false
    scheduler.set({ tenantId: "fabrikam", enabled: true, frequency: "weekly", weekday: 5, time: "02:00" })
    expect(scheduler.list()[0]?.pausedReason).toBeUndefined()
    vi.setSystemTime(new Date(2026, 10, 20, 3))
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
  })
})

it("starts weekly fallback promptly when coverage is revoked before its saved expiry", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 8, 12))
  let plan: Plan = "pro"
  const run = vi.fn(async () => ({ status: "Completed" as const, message: "Done" }))
  const scheduler = new BackupScheduler(memoryStore(), run, undefined, undefined, () => ({ plan, azure: false, endedAt: new Date(2026, 10, 23, 12).getTime() }))
  scheduler.set({ tenantId: "contoso", enabled: true, frequency: "daily", time: "02:00" })
  vi.setSystemTime(new Date(2026, 10, 9, 1))
  plan = "community"
  expect(scheduler.list()[0]?.fallbackWeekday).toBe(1)
  vi.setSystemTime(new Date(2026, 10, 9, 2))
  await scheduler.tick()
  expect(run).toHaveBeenCalledTimes(1)
})
