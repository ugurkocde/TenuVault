import { describe, expect, it } from "vitest"
import { Preferences } from "../src/main/preferences"
import { firstBackupNote, retentionNote, restoreCountNote, shouldShowDriftNote, weeklyScheduleNote } from "../src/renderer/lib/plan-notes"
import type { Plan } from "../src/shared/plans"

const now = new Date("2026-10-12T12:00:00Z")
const backup = (days: number) => ({ timestamp: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString() })

for (const plan of ["pro", "msp", null] as const) {
  it(`shows no new notes for ${plan ?? "unknown"} plans`, () => {
    expect(shouldShowDriftNote(plan, 1)).toBe(false)
    expect(retentionNote(plan, [backup(24)], now)).toBeNull()
    expect(restoreCountNote(plan, 2)).toBeNull()
    expect(weeklyScheduleNote(plan)).toBeNull()
    expect(firstBackupNote(plan, false)).toBeNull()
  })
}

describe("Community plan notes", () => {
  it("shows the drift note only when a comparison found policies", () => {
    expect(shouldShowDriftNote("community", 0)).toBe(false)
    expect(shouldShowDriftNote("community", 1)).toBe(true)
    expect(shouldShowDriftNote("community", 5)).toBe(true)
  })

  it("starts the retention note exactly seven days before the cap", () => {
    expect(retentionNote("community", [backup(22)], now)).toBeNull()
    expect(retentionNote("community", [backup(23 - 1 / 86400)], now)).toBeNull()
    for (const days of [23, 24, 30, 31]) {
      const date = new Date(backup(days).timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      expect(retentionNote("community", [backup(days)], now)).toBe(`Backups older than 30 days are removed on Community after the next complete backup. The oldest here is from ${date}. Pro keeps 7 to 365 days, or forever.`)
    }
  })

  it("uses the oldest valid listed date regardless of order and leaves the list intact", () => {
    const backups = [backup(1), backup(24), { timestamp: "not a date" }, backup(2)]
    const original = backups.slice()
    expect(retentionNote("community", backups, now)).toBe(retentionNote("community", [backup(24)], now))
    expect(backups).toEqual(original)
    expect(retentionNote("community", [], now)).toBeNull()
    expect(retentionNote("community", [{ timestamp: "invalid" }], now)).toBeNull()
    expect(retentionNote("community", [backup(-1)], now)).toBeNull()
    expect(retentionNote("community", [backup(24)], new Date("invalid"))).toBeNull()
  })

  it("counts selections starting at two items", () => {
    for (const count of [0, 1]) expect(restoreCountNote("community", count)).toBeNull()
    expect(restoreCountNote("community", 2)).toBe("Restore all 2 at once with Pro. Community restores one item at a time as an unassigned copy.")
    expect(restoreCountNote("community", 12)).toContain("Restore all 12 at once with Pro.")
  })

  it("explains the weekly schedule's consequence", () => {
    expect(weeklyScheduleNote("community")).toBe("A weekly schedule can leave up to six days of changes unprotected.")
  })

  it("shows the first backup note only after the machine flag is known and unseen", () => {
    expect(firstBackupNote("community", null)).toBeNull()
    expect(firstBackupNote("community", true)).toBeNull()
    expect(firstBackupNote("community", false)).toBe("Backed up on this device. Pro can also store encrypted copies in your own Azure storage account and keep them longer.")
  })

  it("persists the shown flag across preference instances and unrelated changes", () => {
    const values = new Map<string, string>()
    const store = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => void values.set(key, value), delete: (key: string) => void values.delete(key) }
    const preferences = new Preferences(store)
    expect(preferences.get().firstBackupNoteSeen).toBe(false)
    preferences.set({ firstBackupNoteSeen: true })
    const restarted = new Preferences(store)
    restarted.set({ retentionDays: 90 })
    for (const plan of ["community", "pro", "msp", null] as Array<Plan | null>) {
      expect(firstBackupNote(plan, restarted.get().firstBackupNoteSeen)).toBeNull()
    }
    expect(() => restarted.set({ firstBackupNoteSeen: "true" } as never)).toThrow("Invalid value for firstBackupNoteSeen.")
  })
})
