import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { completeForRetention, effectiveRetentionTiers, retentionBackupTime, retentionTierSummary, selectRetentionTiers, validRetentionTier, type RetentionTiers } from "../src/shared/backup-retention"
import { effectiveRetentionDays } from "../src/shared/plans"

const backup = (id: string, date: string, complete = true) => ({ id, time: Date.parse(date), complete })

describe("retention tiers in America/New_York", () => {
  const previous = process.env.TZ
  beforeAll(() => { process.env.TZ = "America/New_York" })
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  })

  it("uses the local month and year at midnight, and does not fill gaps with older months", () => {
    const result = selectRetentionTiers([
      backup("December", "2027-01-01T04:59:59Z"),
      backup("January", "2027-01-01T05:00:00Z"),
      backup("Older December", "2026-12-20T00:00:00Z"),
      backup("October", "2026-10-30T00:00:00Z"),
      backup("Too old", "2025-11-30T00:00:00Z"),
    ], new Date("2027-03-01T04:59:59Z"), 30, { retentionMonths: 3, retentionYears: 2 })
    expect(result.newest).toBe("January")
    expect([...result.tiers]).toEqual([["January", "Monthly and yearly"], ["December", "Monthly and yearly"]])
  })

  it("orders by instant across the repeated local hour at the end of daylight saving time", () => {
    const result = selectRetentionTiers([
      backup("First 01:50", "2026-11-01T05:50:00Z"),
      backup("Second 01:10", "2026-11-01T06:10:00Z"),
      backup("October local", "2026-11-01T03:59:59Z"),
    ], new Date("2026-12-04T00:00:00Z"), 30, { retentionMonths: 3 })
    expect([...result.tiers]).toEqual([["Second 01:10", "Monthly"], ["October local", "Monthly"]])
  })

  it("keeps the rolling daily boundary at 24 hours across the spring transition", () => {
    const result = selectRetentionTiers([
      backup("At cutoff", "2026-03-07T13:00:00Z"),
      backup("Before cutoff", "2026-03-07T12:59:59Z"),
      backup("February", "2026-02-28T21:00:00Z"),
    ], new Date("2026-03-08T13:00:00Z"), 1, { retentionMonths: 2 })
    expect([...result.tiers]).toEqual([["February", "Monthly"]])
  })

  it("ignores incomplete and failed backups even if they are newer than a keeper", () => {
    const result = selectRetentionTiers([
      backup("Latest incomplete", "2026-07-20T12:30:00Z", false),
      backup("Successful", "2026-07-15T12:30:00Z"),
      backup("Only failed in June", "2026-06-28T12:30:00Z", false),
    ], new Date("2026-09-01T12:30:00Z"), 30, { retentionMonths: 4, retentionYears: 1 })
    expect(result.newest).toBe("Latest incomplete")
    expect([...result.tiers]).toEqual([["Successful", "Monthly and yearly"]])
  })

  it("keeps a prior year while the latest backup of this year is still in daily retention", () => {
    const result = selectRetentionTiers([
      backup("Current year", "2027-02-15T12:30:00Z"),
      backup("Last year", "2026-09-20T12:30:00Z"),
      backup("Another backup last year", "2026-06-01T12:30:00Z"),
    ], new Date("2027-02-17T12:30:00Z"), 30, { retentionYears: 2 })
    expect([...result.tiers]).toEqual([["Last year", "Yearly"]])
  })
})

describe("retention tier settings", () => {
  const tiers: RetentionTiers = { retentionMonths: 12, retentionYears: 7 }
  it.each(["community", null] as const)("applies only existing daily retention on %s", (plan) => {
    expect(effectiveRetentionTiers(tiers, plan)).toEqual({})
    expect(effectiveRetentionDays(90, plan)).toBe(30)
    expect(effectiveRetentionDays(0, plan)).toBe(30)
    expect(effectiveRetentionDays(14, plan)).toBe(14)
  })

  it.each(["pro", "msp"] as const)("enables tiers on %s and leaves Forever untouched", (plan) => {
    const policy = effectiveRetentionTiers(tiers, plan)
    expect(retentionTierSummary(30, policy)).toBe("All backups for 30 days, then one a month for 12 months and one a year for 7 years")
    expect(retentionTierSummary(0, policy)).toBeNull()
    expect(selectRetentionTiers([backup("old", "2026-01-01T12:00:00Z")], new Date("2026-03-01T12:00:00Z"), 0, policy).tiers.size).toBe(0)
  })

  it("allows whole counts only, including zero to turn a tier off", () => {
    expect(validRetentionTier("retentionMonths", 0)).toBe(true)
    expect(validRetentionTier("retentionMonths", 120)).toBe(true)
    expect(validRetentionTier("retentionMonths", 121)).toBe(false)
    expect(validRetentionTier("retentionYears", 50)).toBe(true)
    for (const invalid of [-1, 51, 1.5, Infinity, "7", null]) expect(validRetentionTier("retentionYears", invalid)).toBe(false)
    expect(retentionTierSummary(1, { retentionMonths: 1 })).toBe("All backups for 1 day, then one a month for 1 month")
    expect(retentionTierSummary(30, {})).toBeNull()
  })

  it("requires a completed manifest, including earlier cloud and desktop status values", () => {
    expect(completeForRetention({ Status: "Success" })).toBe(true)
    expect(completeForRetention({ Status: "Succeeded", Failures: 0 })).toBe(true)
    expect(completeForRetention({ Status: "Success", Failures: 1 })).toBe(false)
    for (const Status of ["Failed", "CompletedWithWarnings", "Cancelled", "Running", "Incomplete"]) {
      expect(completeForRetention({ Status })).toBe(false)
    }
    expect(completeForRetention(null)).toBe(false)
    expect(retentionBackupTime("backup-2026-01-02-010203")).toBe(Date.parse("2026-01-02T01:02:03Z"))
    expect(retentionBackupTime("2026-01-02")).toBeNull()
  })
})
