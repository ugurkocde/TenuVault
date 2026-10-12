import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupScheduler, type ScheduledRunResult } from "../src/main/backup/scheduler"
import { memoryStore } from "./helpers"

const TENANT = "11111111-1111-1111-1111-111111111111"

function setup(start: string) {
  let now = new Date(start)
  const run = vi.fn(async (): Promise<ScheduledRunResult> => ({ status: "Completed", message: "Backup completed successfully" }))
  const store = memoryStore()
  const scheduler = new BackupScheduler(store, run, () => undefined, () => now)
  return { scheduler, store, run, setNow: (iso: string) => (now = new Date(iso)) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// Local times: the scheduler works in the computer's time zone.
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString()

describe("BackupScheduler", () => {
  it("keeps the back-off and three-attempt budget across restarts with real clock timers", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 10, 1))
    const store = memoryStore()
    const run = vi.fn(async (): Promise<ScheduledRunResult> => ({ status: "Failed", message: "Network unavailable" }))
    let scheduler = new BackupScheduler(store, run)
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    vi.setSystemTime(new Date(2026, 9, 10, 2))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(30_000)
    scheduler.stop()
    expect(run).toHaveBeenCalledTimes(1)
    scheduler = new BackupScheduler(store, run)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(run).toHaveBeenCalledTimes(3)
    scheduler.stop()
    const restarted = new BackupScheduler(store, run)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await restarted.tick()
    expect(run).toHaveBeenCalledTimes(3)
    expect(restarted.list()[0]!.lastRunAt).toBeUndefined()
    expect(restarted.list()[0]!.attempts).toBe(3)
  })

  it("reserves an in-flight attempt before work starts so a process restart cannot reset it", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 10, 1))
    const store = memoryStore()
    let finish!: (result: ScheduledRunResult) => void
    const scheduler = new BackupScheduler(store, () => new Promise(resolve => { finish = resolve }))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    vi.setSystemTime(new Date(2026, 9, 10, 2))
    const pending = scheduler.tick()
    const restarted = new BackupScheduler(store, async () => ({ status: "Completed", message: "Done" }))
    expect(restarted.list()[0]).toMatchObject({ attempts: 1, attemptSlot: new Date(2026, 9, 10, 2).toISOString() })
    expect(restarted.isDue(restarted.list()[0]!)).toBe(false)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(restarted.isDue(restarted.list()[0]!)).toBe(true)
    finish({ status: "Failed", message: "Interrupted" })
    await pending
  })

  it("runs a daily backup once per day at the chosen time", async () => {
    const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    expect(scheduler.list()[0]!.nextRunAt).toBe(local(2026, 9, 25, 2))

    setNow(local(2026, 9, 25, 1, 59))
    await scheduler.tick()
    expect(run).not.toHaveBeenCalled()

    setNow(local(2026, 9, 25, 2, 1))
    await scheduler.tick()
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(scheduler.list()[0]).toMatchObject({ lastStatus: "Completed", nextRunAt: local(2026, 9, 26, 2) })
  })

  it("catches up a missed backup once when the app starts again", async () => {
    const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    // The computer was off for three days.
    setNow(local(2026, 9, 28, 9))
    await scheduler.tick()
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("does not run for slots before the schedule was created or changed", async () => {
    const { scheduler, run } = setup(local(2026, 9, 24, 10))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    await scheduler.tick()
    expect(run).not.toHaveBeenCalled()
  })

  it("runs weekly schedules on the chosen day", async () => {
    // 2026-09-24 is a Thursday.
    const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "weekly", weekday: 1, time: "03:30" })
    expect(scheduler.list()[0]!.nextRunAt).toBe(local(2026, 9, 28, 3, 30))
    setNow(local(2026, 9, 27, 23))
    await scheduler.tick()
    expect(run).not.toHaveBeenCalled()
    setNow(local(2026, 9, 28, 3, 31))
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("records failures and skips disabled schedules", async () => {
    const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
    run.mockRejectedValueOnce(new Error("Sign in again to continue."))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    scheduler.set({ tenantId: "22222222-2222-2222-2222-222222222222", enabled: false, frequency: "daily", time: "02:00" })
    setNow(local(2026, 9, 25, 3))
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(scheduler.list().find((s) => s.tenantId === TENANT)).toMatchObject({ lastStatus: "Failed", lastMessage: "Sign in again to continue." })
  })

  it("validates input", () => {
    const { scheduler } = setup(local(2026, 9, 24, 10))
    expect(() => scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "25:00" })).toThrow(/time/)
    expect(() => scheduler.set({ tenantId: TENANT, enabled: true, frequency: "weekly", time: "02:00" })).toThrow(/day of the week/)
    expect(() => scheduler.set({ tenantId: TENANT, enabled: true, frequency: "weekly", time: "02:00", weekday: 1.5 })).toThrow(/day of the week/)
  })

  it("retries a failed slot after 15 minutes and preserves the last successful run", async () => {
    const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    setNow(local(2026, 9, 25, 2))
    await scheduler.tick()
    run.mockRejectedValueOnce(new Error("Network unavailable"))
    setNow(local(2026, 9, 26, 2))
    await scheduler.tick()
    expect(scheduler.list()[0]).toMatchObject({
      lastRunAt: local(2026, 9, 25, 2), lastAttemptAt: local(2026, 9, 26, 2),
      lastStatus: "Failed", attempts: 1, nextRunAt: local(2026, 9, 26, 2, 15),
    })
    expect(scheduler.next()?.at.toISOString()).toBe(local(2026, 9, 26, 2, 15))
    setNow(local(2026, 9, 26, 2, 14))
    expect(scheduler.isDue(scheduler.list()[0]!)).toBe(false)
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(2)
    setNow(local(2026, 9, 26, 2, 15))
    expect(scheduler.isDue(scheduler.list()[0]!)).toBe(true)
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(3)
    expect(scheduler.list()[0]).toMatchObject({ attempts: 0, lastStatus: "Completed", lastRunAt: local(2026, 9, 26, 2, 15) })
  })

  it.each(["daily", "weekly"] as const)("stops after three failures and resets the budget at the next %s slot", async (frequency) => {
    const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
    run.mockResolvedValue({ status: "Failed", message: "Network unavailable" })
    scheduler.set({ tenantId: TENANT, enabled: true, frequency, weekday: 5, time: "02:00" })
    for (const minute of [0, 15, 30]) {
      setNow(local(2026, 9, 25, 2, minute))
      await scheduler.tick()
    }
    expect(run).toHaveBeenCalledTimes(3)
    const nextSlot = frequency === "daily" ? local(2026, 9, 26, 2) : local(2026, 10, 2, 2)
    expect(scheduler.list()[0]).toMatchObject({ attempts: 3, nextRunAt: nextSlot })
    expect(scheduler.list()[0]!.lastRunAt).toBeUndefined()
    setNow(local(2026, 9, 25, 10))
    expect(scheduler.isDue(scheduler.list()[0]!)).toBe(false)
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(3)
    setNow(nextSlot)
    expect(scheduler.isDue(scheduler.list()[0]!)).toBe(true)
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(4)
    expect(scheduler.list()[0]!.attempts).toBe(1)
  })

  it("persists retry state across scheduler restarts", async () => {
    const { scheduler, store, run, setNow } = setup(local(2026, 9, 24, 10))
    run.mockResolvedValue({ status: "Failed", message: "Network unavailable" })
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    setNow(local(2026, 9, 25, 9))
    await scheduler.tick()
    const restarted = new BackupScheduler(store, run, () => undefined, () => new Date(local(2026, 9, 25, 9, 14)))
    expect(restarted.list()[0]).toMatchObject({ attempts: 1, attemptSlot: local(2026, 9, 25, 2), lastAttemptAt: local(2026, 9, 25, 9), nextRunAt: local(2026, 9, 25, 9, 15) })
    await restarted.tick()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each(["daily", "weekly"] as const)("keeps a third attempt crossing the next %s slot on its original budget", async (frequency) => {
    const { scheduler, store, run, setNow } = setup(local(2026, 9, 19, 10))
    const originalSlot = frequency === "daily" ? local(2026, 9, 26, 2) : local(2026, 9, 20, 2)
    run.mockResolvedValue({ status: "Failed", message: "Network unavailable" })
    scheduler.set({ tenantId: TENANT, enabled: true, frequency, weekday: 0, time: "02:00" })
    for (const minute of [29, 44]) {
      setNow(local(2026, 9, 27, 1, minute))
      await scheduler.tick()
    }
    run.mockImplementationOnce(async () => {
      setNow(local(2026, 9, 27, 2, 4))
      return { status: "Failed", message: "Network unavailable" }
    })
    setNow(local(2026, 9, 27, 1, 59))
    await scheduler.tick()
    expect(scheduler.list()[0]).toMatchObject({ attempts: 3, attemptSlot: originalSlot, lastAttemptAt: local(2026, 9, 27, 2, 4), nextRunAt: local(2026, 9, 27, 2, 4) })
    const restarted = new BackupScheduler(store, run, () => undefined, () => new Date(local(2026, 9, 27, 2, 4)))
    expect(restarted.isDue(restarted.list()[0]!)).toBe(true)
    await restarted.tick()
    expect(run).toHaveBeenCalledTimes(4)
    expect(restarted.list()[0]).toMatchObject({ attempts: 1, attemptSlot: local(2026, 9, 27, 2) })
  })

  it("clears both timers on stop and can restart", async () => {
    vi.useFakeTimers()
    const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    setNow(local(2026, 9, 25, 2))
    scheduler.start()
    scheduler.start()
    expect(vi.getTimerCount()).toBe(2)
    scheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).not.toHaveBeenCalled()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["disable", "remove"])("does not run a schedule changed to %s during an earlier backup", async (change) => {
    const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
    const second = "22222222-2222-2222-2222-222222222222"
    const input = { tenantId: second, enabled: true, frequency: "daily" as const, time: "02:00" }
    scheduler.set({ ...input, tenantId: TENANT })
    scheduler.set(input)
    let finish!: (result: ScheduledRunResult) => void
    run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    setNow(local(2026, 9, 25, 2))
    const tick = scheduler.tick()
    expect(scheduler.tick()).toBe(tick)
    if (change === "disable") scheduler.set({ ...input, enabled: false })
    else scheduler.remove(second)
    finish({ status: "Completed", message: "Backup completed successfully" })
    await tick
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(TENANT)
  })

  it("skips and logs malformed stored entries while keeping valid schedules", () => {
    const { scheduler, store } = setup(local(2026, 9, 24, 10))
    const good = scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    const invalid = [null, [], { time: "25:00" }, { since: "not a date" }, { frequency: "monthly" },
      { enabled: "yes" }, { frequency: "weekly", weekday: 1.5 }, { lastAttemptAt: "bad" }, { attempts: -1 },
      { attempts: 4 }, { lastStatus: "Running" }, { lastRunAt: "bad" }, { attemptSlot: "bad" }]
    const entries = Object.fromEntries(invalid.map((value, index) => {
      const id = `bad-${index}`
      return [id, value === null || Array.isArray(value) ? value : { ...good, tenantId: id, ...value }]
    }))
    store.set("backup.schedules", JSON.stringify({ [TENANT]: good, ...entries }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    expect(scheduler.list()).toEqual([good])
    expect(warn).toHaveBeenCalledTimes(invalid.length)
  })

  it("loads old failures as retryable attempts rather than successful backups", () => {
    const { scheduler, store, setNow } = setup(local(2026, 9, 24, 10))
    const { attempts: _attempts, ...legacy } = scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    store.set("backup.schedules", JSON.stringify({ [TENANT]: { ...legacy, lastRunAt: local(2026, 9, 25, 2), lastStatus: "Failed" } }))
    setNow(local(2026, 9, 25, 2, 14))
    expect(scheduler.list()[0]).toMatchObject({ attempts: 1, lastAttemptAt: local(2026, 9, 25, 2), nextRunAt: local(2026, 9, 25, 2, 15) })
    expect(scheduler.list()[0]!.lastRunAt).toBeUndefined()
    setNow(local(2026, 9, 25, 2, 15))
    expect(scheduler.isDue(scheduler.list()[0]!)).toBe(true)
  })
})
