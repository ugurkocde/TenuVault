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
  it("catches up on the 60 second interval after sleep advances the wall clock", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 10, 1))
    const run = vi.fn(async (): Promise<ScheduledRunResult> => ({ status: "Completed", message: "Done" }))
    const scheduler = new BackupScheduler(memoryStore(), run)
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).not.toHaveBeenCalled()
    vi.setSystemTime(new Date(2026, 9, 13, 9))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledExactlyOnceWith(TENANT)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(scheduler.list()[0]).toMatchObject({ lastRunAt: local(2026, 10, 13, 9, 1), nextRunAt: local(2026, 10, 14, 2) })
    scheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("runs midnight slots once on each day across the interval boundary", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 10, 23, 58))
    const run = vi.fn(async (): Promise<ScheduledRunResult> => ({ status: "Completed", message: "Done" }))
    const scheduler = new BackupScheduler(memoryStore(), run)
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "00:00" })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(119_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(scheduler.list()[0]).toMatchObject({ lastRunAt: local(2026, 10, 11, 0), nextRunAt: local(2026, 10, 12, 0) })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date(2026, 9, 11, 23, 59))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(scheduler.list()[0]).toMatchObject({ lastRunAt: local(2026, 10, 12, 0), nextRunAt: local(2026, 10, 13, 0) })
    scheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["daily", "weekly"] as const)("skips a cancelled %s slot across restarts without consuming its retry budget", async frequency => {
    const { scheduler, store, run, setNow } = setup(local(2026, 9, 24, 10))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency, weekday: 5, time: "02:00" })
    run.mockResolvedValueOnce({ status: "Failed", message: "Network unavailable" })
    setNow(local(2026, 9, 25, 2))
    await scheduler.tick()
    run.mockResolvedValueOnce({ status: "Cancelled", message: "Backup cancelled by you." })
    setNow(local(2026, 9, 25, 2, 15))
    await scheduler.tick()
    const next = frequency === "daily" ? local(2026, 9, 26, 2) : local(2026, 10, 2, 2)
    expect(scheduler.list()[0]).toMatchObject({ lastStatus: "Cancelled", attempts: 1, nextRunAt: next })
    expect(scheduler.list()[0]!.lastRunAt).toBeUndefined()
    const restarted = new BackupScheduler(store, run, () => undefined, () => new Date(local(2026, 9, 25, 3)))
    expect(restarted.list()[0]).toMatchObject({ lastStatus: "Cancelled", attempts: 1, nextRunAt: next })
    expect(restarted.isDue(restarted.list()[0]!)).toBe(false)
    await restarted.tick()
    expect(run).toHaveBeenCalledTimes(2)
    setNow(next)
    run.mockResolvedValueOnce({ status: "Failed", message: "Network unavailable" })
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(3)
    expect(scheduler.list()[0]).toMatchObject({ lastStatus: "Failed", attempts: 1, attemptSlot: next })
  })

  it("returns the reserved first attempt after cancellation and preserves the previous successful run", async () => {
    const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
    setNow(local(2026, 9, 25, 2))
    await scheduler.tick()
    run.mockResolvedValueOnce({ status: "Cancelled", message: "Backup cancelled by you." })
    setNow(local(2026, 9, 26, 2))
    await scheduler.tick()
    expect(scheduler.list()[0]).toMatchObject({ lastStatus: "Cancelled", attempts: 0, lastRunAt: local(2026, 9, 25, 2), nextRunAt: local(2026, 9, 27, 2) })
    setNow(local(2026, 9, 26, 2, 15))
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it.each(["daily", "weekly"] as const)("retries an unfinished next %s slot after restarting following cancellation", async frequency => {
    const { scheduler, store, run, setNow } = setup(local(2026, 9, 27, 10))
    scheduler.set({ tenantId: TENANT, enabled: true, frequency, weekday: 1, time: "02:00" })
    run.mockResolvedValueOnce({ status: "Cancelled", message: "Backup cancelled by you." })
    setNow(local(2026, 9, 28, 2))
    await scheduler.tick()
    expect(scheduler.list()[0]).toMatchObject({ lastStatus: "Cancelled", attempts: 0 })

    const nextSlot = frequency === "daily" ? local(2026, 9, 29, 2) : local(2026, 10, 5, 2)
    setNow(nextSlot)
    let finish!: (result: ScheduledRunResult) => void
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = scheduler.tick()
    // A new process only sees the state saved before the unfinished attempt.
    const restartedStore = memoryStore()
    restartedStore.set("backup.schedules", store.get("backup.schedules")!)
    finish({ status: "Failed", message: "Interrupted" })
    await pending

    let now = new Date(nextSlot)
    const retry = vi.fn(async (): Promise<ScheduledRunResult> => ({ status: "Failed", message: "Network unavailable" }))
    const restarted = new BackupScheduler(restartedStore, retry, () => undefined, () => now)
    expect(restarted.list()[0]).toMatchObject({ attemptSlot: nextSlot, attempts: 1, nextRunAt: new Date(now.getTime() + 15 * 60_000).toISOString() })
    expect(restarted.isDue(restarted.list()[0]!)).toBe(false)
    await restarted.tick()
    expect(retry).not.toHaveBeenCalled()
    now = new Date(now.getTime() + 15 * 60_000)
    expect(restarted.isDue(restarted.list()[0]!)).toBe(true)
    await restarted.tick()
    expect(restarted.list()[0]).toMatchObject({ attempts: 2, lastStatus: "Failed" })
    now = new Date(now.getTime() + 15 * 60_000)
    await restarted.tick()
    expect(restarted.list()[0]!.attempts).toBe(3)
    now = new Date(now.getTime() + 15 * 60_000)
    await restarted.tick()
    expect(retry).toHaveBeenCalledTimes(2)
    expect(restarted.list()[0]!.lastRunAt).toBeUndefined()
  })

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

  describe("failures to reach Microsoft or storage", () => {
    const unreachable: ScheduledRunResult = { status: "Failed", message: "network_error: Network request failed: login.microsoftonline.com could not be reached. (ERR_TIMED_OUT)", unreachable: true }
    const counted: ScheduledRunResult = { status: "Failed", message: "Sign in again to continue." }

    it("are not counted during the dark wakes of a sleeping Mac, but wait 15 minutes each", async () => {
      const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
      run.mockResolvedValue(unreachable)
      scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
      // Each brief wake runs the minute timer; the ones within 15 minutes of a failure do not start a backup.
      for (const [hour, minute] of [[2, 0], [2, 5], [2, 14], [2, 16], [2, 20], [2, 33], [2, 49], [5, 2], [5, 16]] as const) {
        setNow(local(2026, 9, 25, hour, minute))
        await scheduler.tick()
      }
      expect(run).toHaveBeenCalledTimes(5)
      expect(scheduler.list()[0]).toMatchObject({ lastStatus: "Failed", attempts: 0, attemptSlot: local(2026, 9, 25, 2), lastAttemptAt: local(2026, 9, 25, 5, 2), nextRunAt: local(2026, 9, 25, 5, 17) })
      expect(scheduler.list()[0]!.lastRunAt).toBeUndefined()
      setNow(local(2026, 9, 25, 7, 30))
      expect(scheduler.isDue(scheduler.list()[0]!)).toBe(true)
      run.mockResolvedValueOnce({ status: "Completed", message: "Done" })
      await scheduler.tick()
      expect(scheduler.list()[0]).toMatchObject({ lastStatus: "Completed", lastRunAt: local(2026, 9, 25, 7, 30), attempts: 0, nextRunAt: local(2026, 9, 26, 2) })
      setNow(local(2026, 9, 25, 8))
      await scheduler.tick()
      expect(run).toHaveBeenCalledTimes(6)
    })

    it("still wait 15 minutes between attempts when the timer fires every minute", async () => {
      const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
      run.mockResolvedValue(unreachable)
      scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
      for (let minute = 0; minute < 60; minute++) {
        setNow(local(2026, 9, 25, 2, minute))
        await scheduler.tick()
      }
      expect(run).toHaveBeenCalledTimes(4)
      expect(scheduler.list()[0]).toMatchObject({ attempts: 0, lastAttemptAt: local(2026, 9, 25, 2, 45), nextRunAt: local(2026, 9, 25, 3) })
    })

    it("never let counted failures exceed three, and keep retrying the uncounted ones", async () => {
      const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
      scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
      run.mockResolvedValueOnce(counted).mockResolvedValueOnce(counted)
      run.mockResolvedValueOnce(unreachable).mockResolvedValueOnce(unreachable).mockResolvedValueOnce(unreachable)
      run.mockResolvedValue(counted)
      const attempts: number[] = []
      for (const [hour, minute] of [[2, 0], [2, 15], [2, 30], [2, 45], [3, 0], [3, 15], [3, 30], [3, 45]] as const) {
        setNow(local(2026, 9, 25, hour, minute))
        await scheduler.tick()
        attempts.push(scheduler.list()[0]!.attempts)
      }
      expect(run).toHaveBeenCalledTimes(6)
      expect(attempts).toEqual([1, 2, 2, 2, 2, 3, 3, 3])
      expect(scheduler.list()[0]).toMatchObject({ lastStatus: "Failed", lastMessage: counted.message, nextRunAt: local(2026, 9, 26, 2) })
      setNow(local(2026, 9, 26, 2))
      await scheduler.tick()
      expect(run).toHaveBeenCalledTimes(7)
      expect(scheduler.list()[0]).toMatchObject({ attempts: 1, attemptSlot: local(2026, 9, 26, 2) })
    })

    it("keep the wait across restarts", async () => {
      const { scheduler, store, run, setNow } = setup(local(2026, 9, 24, 10))
      run.mockResolvedValue(unreachable)
      scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
      setNow(local(2026, 9, 25, 2))
      await scheduler.tick()
      let now = new Date(local(2026, 9, 25, 2, 14))
      const restarted = new BackupScheduler(store, run, () => undefined, () => now)
      expect(restarted.list()[0]).toMatchObject({ attempts: 0, lastStatus: "Failed", attemptSlot: local(2026, 9, 25, 2), nextRunAt: local(2026, 9, 25, 2, 15) })
      await restarted.tick()
      expect(run).toHaveBeenCalledTimes(1)
      now = new Date(local(2026, 9, 25, 2, 15))
      expect(restarted.isDue(restarted.list()[0]!)).toBe(true)
      await restarted.tick()
      expect(run).toHaveBeenCalledTimes(2)
      expect(restarted.list()[0]!.attempts).toBe(0)
    })

    it("count when the process stops during the attempt", async () => {
      const { scheduler, store, run, setNow } = setup(local(2026, 9, 24, 10))
      scheduler.set({ tenantId: TENANT, enabled: true, frequency: "daily", time: "02:00" })
      let finish!: (result: ScheduledRunResult) => void
      run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      setNow(local(2026, 9, 25, 2))
      const pending = scheduler.tick()
      const restarted = new BackupScheduler(store, run, () => undefined, () => new Date(local(2026, 9, 25, 2, 1)))
      expect(restarted.list()[0]).toMatchObject({ attempts: 1, nextRunAt: local(2026, 9, 25, 2, 15) })
      finish(unreachable)
      await pending
      expect(scheduler.list()[0]!.attempts).toBe(0)
    })

    it("do not show a retry for a slot before a change made during the attempt", async () => {
      const { scheduler, run, setNow } = setup(local(2026, 9, 24, 10))
      const input = { tenantId: TENANT, enabled: true, frequency: "daily" as const, time: "02:00" }
      scheduler.set(input)
      let finish!: (result: ScheduledRunResult) => void
      run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      setNow(local(2026, 9, 25, 2))
      const pending = scheduler.tick()
      setNow(local(2026, 9, 25, 2, 5))
      scheduler.set(input)
      setNow(local(2026, 9, 25, 2, 10))
      finish(unreachable)
      await pending
      expect(scheduler.list()[0]).toMatchObject({ lastStatus: "Failed", attempts: 0, nextRunAt: local(2026, 9, 26, 2) })
      expect(scheduler.isDue(scheduler.list()[0]!)).toBe(false)
    })
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
