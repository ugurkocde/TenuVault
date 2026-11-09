import { describe, expect, it, vi } from "vitest"
import { announceCommunityChoice, prepareScheduledCoverage, scheduledCoverage } from "../src/main/backup/schedule-prepare"
import type { BackupSchedule } from "../src/shared/ipc"
import { memoryStore } from "./helpers"

const schedule = (tenantId: string, frequency = "weekly", enabled = true) => ({ tenantId, frequency, enabled, time: "23:59", since: new Date().toISOString(), attempts: 0, nextRunAt: null }) as BackupSchedule

describe("scheduled coverage preparation", () => {
  it("checks unchecked tenants before their slot and rechecks Community daily schedules", async () => {
    const license = { plan: (id: string) => id === "unchecked" ? null : id.startsWith("community") ? "community" as const : "pro" as const, requireEntitlement: vi.fn(async (_id: string) => "community") }
    await prepareScheduledCoverage(() => [schedule("unchecked"), schedule("community-daily", "daily"), schedule("community-weekly"), schedule("pro", "daily"), schedule("disabled", "daily", false)], license)
    expect(license.requireEntitlement.mock.calls.map(([id]) => id)).toEqual(["unchecked", "community-daily"])
  })

  it("continues checking other tenants after a refused or unavailable check", async () => {
    const requireEntitlement = vi.fn(async () => { throw new Error("Choose a Community tenant") })
    await prepareScheduledCoverage(() => [schedule("contoso"), schedule("fabrikam")], { plan: () => null, requireEntitlement })
    expect(requireEntitlement).toHaveBeenCalledTimes(2)
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

it("distinguishes missing profiles and local storage from an Azure pause in production coverage", () => {
  const license = { plan: () => "community" as const, coverageEndedAt: () => undefined, communityPendingTenants: () => [] }
  expect(scheduledCoverage(license, "contoso", null).azure).toBe(false)
  expect(scheduledCoverage(license, "contoso", { storageAccountName: "tvlocal-contoso" }).azure).toBe(false)
  expect(scheduledCoverage(license, "contoso", { storageAccountName: "stcontoso" }).azure).toBe(true)
})
