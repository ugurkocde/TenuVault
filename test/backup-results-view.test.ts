import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BackupResults } from "../src/portal/components/backup/backup-results"
import { completedWithWarnings, formatBackupDuration, summarizeBackupResults, typeHeading } from "../src/portal/lib/backup-job-display"
import type { BackupResults as Results, BackupTypeResult } from "../src/shared/backup-results"

const type = (folder: string, fields: Partial<BackupTypeResult>): BackupTypeResult => ({ folder, label: folder.toLowerCase(), area: "Compliance", state: "saved", saved: 0, failed: 0, ...fields })

const results: Results = {
  types: [
    type("Compliance", { label: "compliance policies", found: 6, saved: 6 }),
    type("Settings", { label: "settings catalog policies", found: 3, saved: 2, failed: 1, errors: ["Baseline: Access denied"] }),
    type("Roles", { label: "Intune roles", state: "empty", found: 0, builtInSkipped: 10 }),
    type("Scripts", { label: "PowerShell scripts", state: "skipped", reason: "Access was denied." }),
    type("Apps", { label: "apps", state: "unreadable", reason: "Graph returned 500" }),
    type("Autopilot", { label: "Autopilot devices", inventory: true, found: 4, saved: 4 }),
  ],
  notices: [
    { level: "info", message: "Removed 2 backups older than 30 days." },
    { level: "warning", message: "Retention is paused." },
  ],
}

describe("backup results summary", () => {
  it("splits types into saved, empty and problem groups and leaves inventory out of the policy total", () => {
    const summary = summarizeBackupResults(results)
    expect(summary.saved.map((entry) => entry.folder)).toEqual(["Compliance", "Settings", "Autopilot"])
    expect(summary.empty.map((entry) => entry.folder)).toEqual(["Roles"])
    expect(summary.skipped.map((entry) => entry.folder)).toEqual(["Scripts"])
    expect(summary.unreadable.map((entry) => entry.folder)).toEqual(["Apps"])
    expect(summary.partial.map((entry) => entry.folder)).toEqual(["Settings"])
    expect(summary.policies).toBe(8)
    expect(summary.inventory).toEqual([{ label: "Autopilot devices", count: 4 }])
    expect(summary.warnings).toEqual(["Retention is paused."])
    expect(summary.info).toEqual(["Removed 2 backups older than 30 days."])
    expect(summarizeBackupResults({ ...results, totalPolicies: 20 }).policies).toBe(20)
  })

  it("counts types still being listed or backed up while the run goes", () => {
    const summary = summarizeBackupResults({ types: [type("A", { state: "reading" }), type("B", { state: "reading", found: 5, saved: 2 })], notices: [] })
    expect(summary.pending).toBe(1)
    expect(summary.active.map((entry) => entry.folder)).toEqual(["B"])
  })

  it("formats durations, headings and the warnings state", () => {
    expect(formatBackupDuration("2026-11-12T10:00:00Z", "2026-11-12T10:00:05Z")).toBe("5s")
    expect(formatBackupDuration("2026-11-12T10:00:00Z", "2026-11-12T10:02:05Z")).toBe("2m 5s")
    expect(formatBackupDuration(undefined)).toBe("")
    expect(typeHeading("compliance policies")).toBe("Compliance policies")
    const done = { isComplete: true, isSuccessful: true }
    expect(completedWithWarnings({ ...done, progressMessage: "Backup completed with 2 warnings" })).toBe(true)
    expect(completedWithWarnings({ ...done, progressMessage: "Backup completed successfully" })).toBe(false)
  })
})

describe("BackupResults", () => {
  const job = { status: "Completed", startTime: "2026-11-12T10:00:00Z", endTime: "2026-11-12T10:00:05Z", output: "[10:00:00] Found 6 compliance policies.", results, isComplete: true }

  it("shows totals, problems before results, folds empty types and keeps the raw log collapsed", () => {
    const html = renderToStaticMarkup(createElement(BackupResults, { job, jobId: "desktop-1" }))
    expect(html).toContain("Policies saved")
    expect(html).toContain(">8<")
    expect(html).toContain(">5s<")
    expect(html).toContain("Also saved: 4 Autopilot devices.")
    expect(html.indexOf("Needs attention")).toBeLessThan(html.indexOf("Backed up types"))
    expect(html).toContain("Could not read apps")
    expect(html).toContain("1 of 3 settings catalog policies could not be saved")
    expect(html).toContain("PowerShell scripts left out")
    expect(html).toContain("Retention is paused.")
    expect(html).toContain("1 type had nothing to back up")
    expect(html).toContain("Show raw log")
    expect(html).not.toContain("Found 6 compliance policies")
    expect(html).not.toContain("bg-slate-9")
  })

  it("shows a one line summary and at most five types in the compact panel", () => {
    const many: Results = { types: Array.from({ length: 8 }, (_, index) => type(`T${index}`, { found: 1, saved: 1 })), notices: [] }
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: many }, compact: true }))
    expect(html).toContain("across 8 types, 5s")
    expect(html.match(/<li /g)?.length).toBe(5)
    expect(html).toContain("and 3 more types")
  })

  it("offers only the raw log when the job has no per type results", () => {
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: undefined } }))
    expect(html).toContain("Show raw log")
    expect(html).not.toContain("Policies saved")
  })
})
