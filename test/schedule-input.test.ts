import { describe, expect, it, vi } from "vitest"
import { BackupScheduler } from "../src/main/backup/scheduler"
import { prepareScheduleInput } from "../src/main/backup/schedule-input"
import type { ScheduleInput } from "../src/shared/ipc"
import { PlanRequired } from "../src/shared/plans"
import { memoryStore } from "./helpers"

const TENANT = "11111111-1111-1111-1111-111111111111"
const daily: ScheduleInput = { tenantId: TENANT, enabled: true, frequency: "daily", time: "07:45" }

describe("schedule input plan checks", () => {
  it("pauses a Pro daily schedule after a Community downgrade and preserves its last result", async () => {
    let now = new Date(2026, 9, 10, 6)
    const run = vi.fn(async () => ({ status: "Failed" as const, message: "Sign in again." }))
    const store = memoryStore()
    const scheduler = new BackupScheduler(store, run, () => undefined, () => now)
    scheduler.set(prepareScheduleInput(daily, "pro"))
    now = new Date(2026, 9, 10, 8)
    await scheduler.tick()
    const current = scheduler.list()[0]!

    scheduler.set(prepareScheduleInput({ ...daily, enabled: false, frequency: "weekly", time: "", weekday: 4 }, "community", current))
    expect(scheduler.list()[0]).toMatchObject({
      enabled: false, frequency: "daily", time: current.time,
      lastStatus: "Failed", lastMessage: "Sign in again.", nextRunAt: null,
    })
    expect(scheduler.list()[0]!.weekday).toBe(current.weekday)
    expect(scheduler.list()[0]!.lastRunAt).toBe(current.lastRunAt)
    expect(JSON.parse(store.get("backup.schedules")!)[TENANT]).toMatchObject({ enabled: false, frequency: "daily", time: "07:45", lastStatus: "Failed" })
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(() => prepareScheduleInput(daily, "community", scheduler.list()[0])).toThrow(PlanRequired)
  })

  it("keeps the saved weekday when pausing on any plan, including an unknown plan", () => {
    const scheduler = new BackupScheduler(memoryStore(), async () => ({ status: "Completed", message: "Done" }))
    const current = scheduler.set({ ...daily, frequency: "weekly", weekday: 2 })
    for (const plan of ["community", "pro", "msp", null] as const) {
      const input = prepareScheduleInput({ ...daily, enabled: false, weekday: 5, time: "25:00" }, plan, current)
      scheduler.set(input)
      expect(scheduler.list()[0]).toMatchObject({ enabled: false, frequency: "weekly", time: "07:45", weekday: 2 })
    }
  })

  it("refuses both enabling and editing active daily schedules on Community", () => {
    const scheduler = new BackupScheduler(memoryStore(), async () => ({ status: "Completed", message: "Done" }))
    const current = scheduler.set(daily)
    expect(() => prepareScheduleInput(daily, "community")).toThrow(PlanRequired)
    expect(() => prepareScheduleInput({ ...daily, time: "09:00" }, "community", current)).toThrow(PlanRequired)
    try {
      prepareScheduleInput(daily, "community")
    } catch (error) {
      expect(error).toMatchObject({ name: "PlanRequired", feature: "dailySchedule" })
    }
  })

  it("keeps weekly scheduling available on Community and daily scheduling on paid plans", () => {
    const weekly: ScheduleInput = { ...daily, frequency: "weekly", weekday: 1 }
    expect(prepareScheduleInput(weekly, "community")).toBe(weekly)
    for (const plan of ["pro", "msp", null] as const) expect(prepareScheduleInput(daily, plan)).toBe(daily)
    const paused = { ...daily, enabled: false }
    expect(prepareScheduleInput(paused, "community")).toBe(paused)
  })
})
