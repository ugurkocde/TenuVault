import { afterEach, describe, expect, it, vi } from "vitest"
import { prepareScheduleInput } from "../src/main/backup/schedule-input"
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
    restarted.set(prepareScheduleInput({ ...saved, enabled: false }, plan, saved))
    expect(notice).toHaveBeenCalledTimes(1)
    restarted.set(prepareScheduleInput({ ...saved, enabled: true }, plan, restarted.list()[0]))
    expect(notice).toHaveBeenCalledTimes(1)
    plan = "pro"
    expect(restarted.list()[0]?.fallbackWeekday).toBeUndefined()
    vi.setSystemTime(new Date(2026, 10, 17, 2))
    await restarted.tick()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("pauses Azure without attempts, failures or runs, and catches up promptly after changing only storage to local", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 8, 12))
    const store = memoryStore()
    let azure = true
    let plan: Plan = "pro"
    const run = vi.fn(async () => ({ status: "Completed" as const, message: "Done" }))
    const notice = vi.fn()
    const scheduler = new BackupScheduler(store, run, undefined, undefined, () => ({ plan, azure }), undefined, notice)
    scheduler.set(prepareScheduleInput({ tenantId: "fabrikam", enabled: true, frequency: "daily", time: "02:00" }, plan))
    plan = "community"
    for (let day = 9; day < 20; day++) {
      vi.setSystemTime(new Date(2026, 10, day, 3))
      await scheduler.tick()
    }
    expect(run).not.toHaveBeenCalled()
    expect(notice).not.toHaveBeenCalled()
    expect(scheduler.list()[0]).toMatchObject({ pausedReason: "Paused: Azure storage needs Pro", attempts: 0, nextRunAt: null })
    expect(scheduler.list()[0]?.lastStatus).toBeUndefined()
    azure = false
    expect(scheduler.list()[0]?.frequency).toBe("daily")
    expect(scheduler.list()[0]?.pausedReason).toBeUndefined()
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
    plan = "pro"
    vi.setSystemTime(new Date(2026, 10, 20, 3))
    await scheduler.tick()
    expect(scheduler.list()[0]?.fallbackWeekday).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
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

it("retries a failed weekly fallback slot on its day and catches up several missed weeks once", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 8, 12))
  let plan: Plan = "pro"
  const run = vi.fn().mockResolvedValueOnce({ status: "Failed", message: "Try again" }).mockResolvedValue({ status: "Completed", message: "Done" })
  const scheduler = new BackupScheduler(memoryStore(), run, undefined, undefined, () => ({ plan, azure: false, endedAt: new Date(2026, 10, 9, 1).getTime() }))
  scheduler.set({ tenantId: "contoso", enabled: true, frequency: "daily", time: "02:00" })
  plan = "community"
  vi.setSystemTime(new Date(2026, 10, 9, 2))
  await scheduler.tick()
  vi.setSystemTime(new Date(2026, 10, 9, 2, 14))
  await scheduler.tick()
  expect(run).toHaveBeenCalledTimes(1)
  vi.setSystemTime(new Date(2026, 10, 9, 2, 15))
  await scheduler.tick()
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls[1]?.[2]).toBe(run.mock.calls[0]?.[2])
  vi.setSystemTime(new Date(2026, 10, 10, 3))
  await scheduler.tick()
  expect(run).toHaveBeenCalledTimes(2)
  vi.setSystemTime(new Date(2026, 11, 3, 12))
  await scheduler.tick()
  await scheduler.tick()
  expect(run).toHaveBeenCalledTimes(3)
  expect(scheduler.list()[0]?.fallbackWeekday).toBe(1)
})

it("persists notices per coverage end and only notifies enabled schedules", () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 8, 12))
  const store = memoryStore()
  let plan: Plan = "pro"
  let azure = false
  let endedAt = new Date(2026, 10, 9, 1).getTime()
  const notice = vi.fn()
  const pause = vi.fn()
  const create = () => new BackupScheduler(store, async () => ({ status: "Completed", message: "Done" }), undefined, undefined, () => ({ plan, azure, endedAt }), undefined, notice, pause)
  let scheduler = create()
  scheduler.set({ tenantId: "contoso", enabled: false, frequency: "daily", time: "02:00" })
  plan = "community"
  scheduler.list()
  expect(notice).not.toHaveBeenCalled()
  azure = true
  scheduler.list()
  expect(pause).not.toHaveBeenCalled()
  azure = false
  scheduler.set(prepareScheduleInput({ ...scheduler.list()[0]!, enabled: true }, plan, scheduler.list()[0]))
  expect(notice).toHaveBeenCalledTimes(1)
  scheduler = create()
  azure = true
  scheduler.list()
  scheduler.list()
  expect(pause).toHaveBeenCalledExactlyOnceWith("contoso", "azure")
  scheduler = create()
  scheduler.list()
  expect(pause).toHaveBeenCalledTimes(1)
  azure = false
  scheduler.list()
  const saved = scheduler.list()[0]!
  scheduler.set(prepareScheduleInput({ ...saved, enabled: false }, plan, saved))
  scheduler.set(prepareScheduleInput({ ...saved, enabled: true }, plan, scheduler.list()[0]))
  expect(notice).toHaveBeenCalledTimes(1)
  plan = "pro"
  scheduler.list()
  endedAt += 7 * 86400_000
  plan = "community"
  scheduler.list()
  expect(notice).toHaveBeenCalledTimes(2)
})

it("keeps the fallback weekday and local time across daylight saving in Europe/Berlin", async () => {
  const timezone = process.env.TZ
  process.env.TZ = "Europe/Berlin"
  try {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-22T12:00:00+02:00"))
    let plan: Plan = "pro"
    const run = vi.fn(async () => ({ status: "Completed" as const, message: "Done" }))
    const scheduler = new BackupScheduler(memoryStore(), run, undefined, undefined, () => ({ plan, azure: false, endedAt: Date.parse("2026-10-23T01:00:00+02:00") }))
    scheduler.set({ tenantId: "contoso", enabled: true, frequency: "daily", time: "09:00" })
    plan = "community"
    vi.setSystemTime(new Date("2026-10-23T09:00:00+02:00"))
    await scheduler.tick()
    expect(scheduler.list()[0]).toMatchObject({ fallbackWeekday: 5, nextRunAt: "2026-10-30T08:00:00.000Z" })
    vi.setSystemTime(new Date("2026-10-30T08:59:00+01:00"))
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date("2026-10-30T09:00:00+01:00"))
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(2)
  } finally {
    if (timezone === undefined) delete process.env.TZ
    else process.env.TZ = timezone
  }
})

it("keeps reads usable when fallback metadata cannot be saved, and defers attempts and notices until it can", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 8, 12))
  const store = memoryStore()
  let plan: Plan = "pro"
  const notice = vi.fn()
  const run = vi.fn(async () => ({ status: "Completed" as const, message: "Done" }))
  const scheduler = new BackupScheduler(store, run, undefined, undefined, () => ({ plan, azure: false, endedAt: new Date(2026, 10, 9, 1).getTime() }), undefined, notice)
  scheduler.set({ tenantId: "contoso", enabled: true, frequency: "daily", time: "02:00" })
  plan = "community"
  vi.setSystemTime(new Date(2026, 10, 9, 3))
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const write = vi.spyOn(store, "set").mockImplementation(() => { throw new Error("Disk unavailable") })
  try {
    expect(scheduler.list()[0]?.fallbackWeekday).toBe(1)
    expect(scheduler.next()?.tenantId).toBe("contoso")
    await expect(scheduler.tick()).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    expect(notice).not.toHaveBeenCalled()
    write.mockRestore()
    await scheduler.tick()
    expect(notice).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  } finally { write.mockRestore(); warning.mockRestore() }
})
