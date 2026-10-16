import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { BackupPairPicker, choose, comparableBackups, fewNote, hiddenNote, optionLabel, pairProblem } from "../src/portal/components/drift/backup-pair-picker"
import { statusKind, statusLabel, type BackupSummary } from "../src/portal/components/backup/types"

const backup = (id: string, timestamp: string, status: string, type: BackupSummary["type"] = "scheduled"): BackupSummary => ({
  id,
  timestamp,
  type,
  status,
  totalPolicies: 3,
  scope: null,
  size: 1,
  duration: null,
  changes: null,
  comparedWith: null,
})

// Two complete backups and three that cannot be compared, newest first as the list returns them.
const backups = [
  backup("stopped", "2026-10-16T05:02:00Z", "incomplete", null),
  backup("newer", "2026-10-15T02:00:00Z", "Success"),
  backup("failed", "2026-10-14T02:00:00Z", "Failed"),
  backup("unread", "2026-10-13T02:00:00Z", "unknown", null),
  backup("older", "2026-10-12T02:00:00Z", "Success", "manual"),
]

const render = (list: BackupSummary[], pair = { baseline: "older", comparison: "newer" }, loading = false, loaded = true) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null,
      createElement(BackupPairPicker, {
        backups: list,
        loading,
        loaded,
        baseline: pair.baseline,
        comparison: pair.comparison,
        onChange: () => undefined,
        onCompare: () => undefined,
        onBackUp: () => undefined,
        busy: false,
        latest: null,
      })),
  )

describe("drift backup picker", () => {
  it("offers only backups that can be compared, keeping ones with warnings", () => {
    const withWarnings = [...backups, backup("warned", "2026-10-11T02:00:00Z", "CompletedWithWarnings")]
    expect(comparableBackups(withWarnings).map((entry) => entry.id)).toEqual(["newer", "older", "warned"])
  })

  it("labels options without a trigger placeholder", () => {
    expect(optionLabel(backups[1]!)).toMatch(/, Scheduled$/)
    expect(optionLabel(backups[4]!)).toMatch(/, Manual$/)
    const untriggered = optionLabel(backup("old", "2026-10-01T02:00:00Z", "Success", null))
    expect(untriggered).not.toMatch(/trigger/i)
    expect(untriggered).not.toMatch(/, $/)
    expect(optionLabel(backup("warned", "2026-10-11T02:00:00Z", "CompletedWithWarnings", null))).toMatch(/(AM|PM|\d), completed with warnings$/)
  })

  it("swaps the pair when the backup on the other side is chosen, keeping the older one as baseline", () => {
    const three = [backup("c", "2026-10-15T02:00:00Z", "Success"), backup("b", "2026-10-14T02:00:00Z", "Success"), backup("a", "2026-10-13T02:00:00Z", "Success")]
    const pair = { baseline: "b", comparison: "c" }
    // Choosing the comparison as baseline swaps; the pair is then reversed and put back in order.
    expect(choose(pair, "baseline", "c", three)).toEqual({ baseline: "b", comparison: "c" })
    expect(choose({ baseline: "a", comparison: "c" }, "comparison", "a", three)).toEqual({ baseline: "a", comparison: "c" })
    expect(choose(pair, "baseline", "a", three)).toEqual({ baseline: "a", comparison: "c" })
    expect(choose(pair, "comparison", "a", three)).toEqual({ baseline: "a", comparison: "b" })
    expect(pairProblem(three, ...Object.values(choose(pair, "comparison", "a", three)) as [string, string])).toBeNull()
    expect(choose({ baseline: null, comparison: "c" }, "comparison", "a", three)).toEqual({ baseline: null, comparison: "a" })
  })

  it("treats a hidden backup in the pair as not chosen from the list", () => {
    expect(pairProblem(comparableBackups(backups), "unread", "newer")).toBe("Choose backups from the list.")
    expect(pairProblem(comparableBackups(backups), "older", "newer")).toBeNull()
  })

  it("says how many backups are not listed, and that only two can be compared", () => {
    const html = render(backups)
    expect(html).toContain(hiddenNote(3))
    expect(html).toContain("3 backups are not listed because they did not finish or their details could not be read.")
    expect(html).toContain('href="/portal/backup"')
    expect(html).toContain(fewNote(2))
    expect(html).toContain("Back up now")
    expect(html).not.toMatch(/trigger not recorded/i)
  })

  it("adds no notes when there are enough backups and none are hidden", () => {
    const many = [backup("c", "2026-10-15T02:00:00Z", "Success"), backup("b", "2026-10-14T02:00:00Z", "Success"), backup("a", "2026-10-13T02:00:00Z", "Success")]
    const html = render(many, { baseline: "b", comparison: "c" })
    expect(html).not.toContain("not listed")
    expect(html).not.toContain("Back up now")
  })

  it("adds no notes while the list loads", () => {
    const html = render(backups, { baseline: "older", comparison: "newer" }, true)
    expect(html).not.toContain("not listed")
    expect(html).not.toContain("Back up now")
  })

  it("adds no notes before a list arrived or when reading it failed", () => {
    const html = render([], { baseline: "older", comparison: "newer" }, false, false)
    expect(html).not.toContain("can be compared")
    expect(html).not.toContain("Back up now")
  })

  it("words the counts for one and none", () => {
    expect(hiddenNote(1)).toBe("1 backup is not listed because it did not finish or its details could not be read.")
    expect(fewNote(1)).toBe("Only one backup can be compared yet. Drift detection needs two complete backups.")
    expect(fewNote(0)).toBe("No backup can be compared yet. Drift detection needs two complete backups.")
  })
})

describe("backup status labels", () => {
  it("does not show a backup with unreadable details as complete", () => {
    expect(statusKind("unknown")).toBe("warning")
    expect(statusLabel("unknown")).toBe("Status unknown")
    expect(statusLabel("incomplete")).toBe("Incomplete")
    expect(statusLabel("Success")).toBe("Complete")
    expect(statusLabel("CompletedWithWarnings")).toBe("Completed with warnings")
    expect(statusLabel("Failed")).toBe("Failed")
  })
})

describe("drift backup picker selection", () => {
  it("shows the placeholder for a chosen backup that is no longer offered", () => {
    const html = render(backups, { baseline: "unread", comparison: "newer" })
    expect(html).toContain("Choose a backup")
    expect(html).toContain("Choose backups from the list.")
  })
})
