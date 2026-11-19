import { expect, it } from "vitest"
import { BackupScheduler, type ScheduledRunResult } from "../src/main/backup/scheduler"
import { memoryStore } from "./helpers"
it("keeps later tenants due while a large run spans scheduler ticks", async () => {
  let now = new Date(2026, 10, 1, 1)
  let finish!: (result: ScheduledRunResult) => void
  const started: string[] = []
  const scheduler = new BackupScheduler(memoryStore(), async tenant => {
    started.push(tenant)
    return tenant === "large" ? new Promise(resolve => { finish = resolve }) : { status: "Completed", message: "Done" }
  }, undefined, () => now, undefined, undefined, undefined, undefined, tenant => tenant === "large")
  scheduler.set({ tenantId: "large", frequency: "daily", time: "02:00", enabled: true })
  scheduler.set({ tenantId: "later", frequency: "daily", time: "03:00", enabled: true })
  now = new Date(2026, 10, 1, 2)
  await scheduler.tick()
  expect(started).toEqual(["large"])
  now = new Date(2026, 10, 1, 3)
  await scheduler.tick()
  expect(started).toEqual(["large", "later"])
  finish({ status: "Completed", message: "Done" })
  await new Promise(resolve => setImmediate(resolve))
  expect(scheduler.list().find(schedule => schedule.tenantId === "large")?.lastStatus).toBe("Completed")
})
