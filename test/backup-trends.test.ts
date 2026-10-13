import { describe, expect, it } from "vitest"
import { backupTypeTrends, type BackupTrendInput } from "../src/portal/lib/backup-trends"

const fixture: BackupTrendInput[] = [
  { timestamp: "2026-09-26T02:00:00Z", counts: { DeviceConfigurations: 3, Apps: 2 }, sizes: { DeviceConfigurations: 3000, Apps: 9000 }, duration: 90 },
  { timestamp: "2026-09-24T02:00:00Z", counts: { DeviceConfigurations: 2, CompliancePolicies: 1 }, sizes: { DeviceConfigurations: 1000, CompliancePolicies: 500 }, duration: 60 },
  { timestamp: "2026-09-25T02:00:00Z", counts: { DeviceConfigurations: 2, Apps: 1 }, sizes: { DeviceConfigurations: 2000, Apps: 4000 }, duration: "1m 15s" },
]

describe("backup type trends", () => {
  it("computes exact per type size and duration aggregation over the recorded history, oldest first", () => {
    const trends = backupTypeTrends(fixture)
    expect(trends.map((trend) => trend.folder)).toEqual(["Apps", "DeviceConfigurations", "CompliancePolicies"])
    const devices = trends[1]!
    expect(devices.points).toEqual([
      { timestamp: "2026-09-24T02:00:00Z", count: 2, sizeBytes: 1000, durationSeconds: 60 },
      { timestamp: "2026-09-25T02:00:00Z", count: 2, sizeBytes: 2000, durationSeconds: null },
      { timestamp: "2026-09-26T02:00:00Z", count: 3, sizeBytes: 3000, durationSeconds: 90 },
    ])
    expect(devices).toMatchObject({
      latestCount: 3,
      latestSizeBytes: 3000,
      averageSizeBytes: 2000,
      sizeChangeBytes: 2000,
      latestDurationSeconds: 90,
      averageDurationSeconds: 75,
      durationChangeSeconds: 30,
    })
    const apps = trends[0]!
    expect(apps.points.map((point) => point.timestamp)).toEqual(["2026-09-25T02:00:00Z", "2026-09-26T02:00:00Z"])
    expect(apps).toMatchObject({ latestCount: 2, latestSizeBytes: 9000, averageSizeBytes: 6500, sizeChangeBytes: 5000, latestDurationSeconds: 90, averageDurationSeconds: 90, durationChangeSeconds: null })
  })

  it("shows a single point honestly for a type held by one backup", () => {
    const [trend] = backupTypeTrends(fixture).filter((entry) => entry.folder === "CompliancePolicies")
    expect(trend?.points).toHaveLength(1)
    expect(trend).toMatchObject({ latestSizeBytes: 500, averageSizeBytes: 500, sizeChangeBytes: null, latestDurationSeconds: 60, averageDurationSeconds: 60, durationChangeSeconds: null })
  })

  it("keeps unknown sizes and durations unknown instead of estimating them", () => {
    const trends = backupTypeTrends([
      { timestamp: "2026-09-24T02:00:00Z", counts: { Apps: 1 }, duration: null },
      { timestamp: "2026-09-25T02:00:00Z", counts: { Apps: 2 }, duration: 30 },
    ])
    expect(trends).toHaveLength(1)
    expect(trends[0]).toMatchObject({ latestSizeBytes: null, averageSizeBytes: null, sizeChangeBytes: null, latestDurationSeconds: 30, averageDurationSeconds: 30, durationChangeSeconds: null })
    expect(trends[0]?.points.map((point) => point.sizeBytes)).toEqual([null, null])
  })

  it("returns no trends for empty or undated history", () => {
    expect(backupTypeTrends([])).toEqual([])
    expect(backupTypeTrends([{ timestamp: "not a date", counts: { Apps: 1 }, sizes: { Apps: 10 }, duration: 5 }])).toEqual([])
    expect(backupTypeTrends([{ timestamp: "2026-09-24T02:00:00Z", counts: { Apps: 0 }, duration: 5 }])).toEqual([])
  })
})
