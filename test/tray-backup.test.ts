import { describe, expect, it } from "vitest"
import { runTrayBackups } from "../src/main/backup/tray-backup"

describe("runTrayBackups", () => {
  it("runs tenants one at a time, in order", async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []
    await runTrayBackups(["a", "b", "c", "d"], async (tenantId) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(tenantId)
      active--
    })
    expect(maxActive).toBe(1)
    expect(order).toEqual(["a", "b", "c", "d"])
  })

  it("still backs up the remaining tenants when one fails", async () => {
    const order: string[] = []
    await runTrayBackups(["a", "b", "c"], async (tenantId) => {
      order.push(tenantId)
      if (tenantId === "b") throw new Error("boom")
    })
    expect(order).toEqual(["a", "b", "c"])
  })
})
