process.env.TZ = "Europe/Berlin"
export {}

const { describe, expect, it, vi } = await import("vitest")
const { BackupScheduler } = await import("../src/main/backup/scheduler")
const { memoryStore } = await import("./helpers")

const TENANT = "11111111-1111-1111-1111-111111111111"
const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute)

describe("BackupScheduler in Europe/Berlin", () => {
  it.each(["daily", "weekly"] as const)("keeps the exhausted previous %s slot before the spring clock change slot", async frequency => {
    let now = local(3, 20, 12)
    const run = vi.fn(async () => ({ status: "Failed" as const, message: "Network unavailable" }))
    const scheduler = new BackupScheduler(memoryStore(), run, () => undefined, () => now)
    scheduler.set({ tenantId: TENANT, enabled: true, frequency, weekday: 0, time: "02:30" })
    const previousSlot = frequency === "daily" ? local(3, 28, 2, 30) : local(3, 22, 2, 30)
    for (const minute of [30, 45, 60]) {
      now = local(3, 28, 2, minute)
      await scheduler.tick()
    }
    expect(run).toHaveBeenCalledTimes(3)
    expect(scheduler.list()[0]!.attemptSlot).toBe(previousSlot.toISOString())
    now = local(3, 29, 3)
    expect(scheduler.isDue(scheduler.list()[0]!)).toBe(false)
    expect(scheduler.list()[0]!.nextRunAt).toBe("2026-03-29T01:30:00.000Z")
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(3)
    now = local(3, 29, 3, 30)
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(4)
    expect(scheduler.list()[0]).toMatchObject({ attempts: 1, attemptSlot: "2026-03-29T01:30:00.000Z" })
    for (const minute of [45, 60]) {
      now = local(3, 29, 3, minute)
      await scheduler.tick()
    }
    // The shifted 03:30 hour must not carry into the following day or week.
    const next = frequency === "daily" ? local(3, 30, 2, 30) : local(4, 5, 2, 30)
    now = new Date(next.getTime() - 60_000)
    expect(scheduler.list()[0]!.nextRunAt).toBe(next.toISOString())
  })

  it.each(["daily", "weekly"] as const)("uses one %s slot for both occurrences of the autumn repeated hour", async frequency => {
    let now = local(10, 17, 12)
    const run = vi.fn(async () => ({ status: "Failed" as const, message: "Network unavailable" }))
    const scheduler = new BackupScheduler(memoryStore(), run, () => undefined, () => now)
    scheduler.set({ tenantId: TENANT, enabled: true, frequency, weekday: 0, time: "02:30" })
    for (const at of ["2026-10-25T00:30:00Z", "2026-10-25T00:45:00Z", "2026-10-25T01:00:00Z"]) {
      now = new Date(at)
      await scheduler.tick()
    }
    expect(run).toHaveBeenCalledTimes(3)
    now = new Date("2026-10-25T01:30:00Z")
    expect(scheduler.isDue(scheduler.list()[0]!)).toBe(false)
    expect(scheduler.list()[0]).toMatchObject({ attempts: 3, attemptSlot: "2026-10-25T00:30:00.000Z" })
    const next = frequency === "daily" ? local(10, 26, 2, 30) : local(11, 1, 2, 30)
    expect(scheduler.list()[0]!.nextRunAt).toBe(next.toISOString())
    now = next
    await scheduler.tick()
    expect(run).toHaveBeenCalledTimes(4)
    expect(scheduler.list()[0]).toMatchObject({ attempts: 1, attemptSlot: next.toISOString() })
  })
})
