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
  it("splits types into rows, empty and problem groups and keeps inventory out of rows and totals", () => {
    const summary = summarizeBackupResults(results)
    expect(summary.rows.map((entry) => entry.folder)).toEqual(["Compliance", "Settings"])
    expect(summary.typesBackedUp).toBe(2)
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
    const live = { types: [type("A", { state: "reading" }), type("B", { state: "reading", found: 5, saved: 2 }), type("C", { found: 2, saved: 0, failed: 2 })], notices: [] }
    const summary = summarizeBackupResults(live)
    expect(summary.pending).toBe(1)
    expect(summary.rows.map((entry) => entry.folder)).toEqual(["B", "C"])
    // A type where nothing was saved is not counted as backed up.
    expect(summary.typesBackedUp).toBe(1)
    expect(summarizeBackupResults(live, true).pending).toBe(0)
  })

  it("formats durations, headings and the warnings state", () => {
    expect(formatBackupDuration("2026-11-12T10:00:00Z", "2026-11-12T10:00:05Z")).toBe("5s")
    expect(formatBackupDuration("2026-11-12T10:00:00Z", "2026-11-12T10:02:05Z")).toBe("2m 5s")
    expect(formatBackupDuration(undefined)).toBe("")
    expect(typeHeading("compliance policies")).toBe("Compliance policies")
    const done = { isComplete: true, isSuccessful: true }
    expect(completedWithWarnings({ ...done, progressMessage: "Backup completed with 2 warnings" })).toBe(true)
    expect(completedWithWarnings({ ...done, progressMessage: "Backup completed successfully" })).toBe(false)
    // The engine's count wins over the message wording.
    expect(completedWithWarnings({ ...done, progressMessage: "Backup completed successfully", results: { types: [], notices: [], warnings: 1 } })).toBe(true)
    expect(completedWithWarnings({ ...done, progressMessage: "Backup completed with 2 warnings", results: { types: [], notices: [], warnings: 0 } })).toBe(false)
    const skipped = { folder: "TermsOfUseAgreements", label: "terms of use", state: "skipped", saved: 0, failed: 0 } as never
    expect(completedWithWarnings({ ...done, progressMessage: "Backup completed successfully", results: { types: [skipped], notices: [], warnings: 0, coverage: "incomplete" } })).toBe(false)
  })
})

describe("BackupResults", () => {
  const job = { status: "Completed", startTime: "2026-11-12T10:00:00Z", endTime: "2026-11-12T10:00:05Z", output: "[10:00:00] Found 6 compliance policies.", results, isComplete: true }

  it("keeps both services visible and in display order even if one service could fill the panel", () => {
    const folders = ["ConfigurationPolicies", "NamedLocations", "AuthenticationContexts", "TermsOfUseAgreements"]
    const types = folders.map(folder => type(folder, { label: folder, saved: 1 }))
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: { types, notices: [] } }, compact: true }))
    const positions = ["NamedLocations", "ConfigurationPolicies"].map(label => html.indexOf(label))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(html).toContain("2 more")
  })

  it("shows totals, problems before results, folds empty types and keeps the raw log collapsed", () => {
    const html = renderToStaticMarkup(createElement(BackupResults, { job, jobId: "desktop-1" }))
    expect(html).toContain("Policies saved")
    expect(html).toContain(">8<")
    expect(html).toContain(">5s<")
    expect(html).toContain("Also saved: 4 Autopilot devices.")
    expect(html).not.toContain(">Autopilot devices<")
    expect(html.indexOf("Needs access")).toBeLessThan(html.indexOf("Backed up types"))
    expect(html).toContain("1 type could not be read.")
    expect(html).toContain("1 of 3 could not be saved.")
    expect(html).toContain("PowerShell scripts")
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

  it("shows a type a cancelled run never finished as stopped, while a separate read failure stays red", () => {
    const stopped: Results = { types: [type("A", { label: "compliance policies", state: "reading", found: 12, saved: 3 }), type("B", { label: "apps", state: "unreadable", reason: "Graph returned 500" })], notices: [] }
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, status: "Cancelled", results: stopped } }))
    expect(html).toContain("Stopped")
    expect(html).toContain("3 of 12")
    expect(html).toContain("stopped before it finished")
    expect(html).not.toContain("animate-spin")
    expect(html).not.toContain("in progress")
    expect(html).toContain('data-notice-tone="error"')
    const running = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, status: "Running", isComplete: false, results: stopped } }))
    expect(running).toContain("animate-spin")
  })

  it("names the types a stopped run never read and words a partial type as stopped", () => {
    const stopped: Results = { types: [type("A", { label: "compliance policies", state: "reading", found: 10, saved: 3, failed: 1, errors: ["X: denied"] }), type("B", { label: "apps", state: "reading" }), type("C", { label: "scripts", state: "reading" })], notices: [] }
    expect(summarizeBackupResults(stopped, true).notReached.map((entry) => entry.folder)).toEqual(["B", "C"])
    expect(summarizeBackupResults(stopped).notReached).toEqual([])
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, status: "Failed", results: stopped } }))
    expect(html).toContain("Stopped before finishing 3 types.")
    expect(html).toContain(">apps<")
    expect(html).toContain(">scripts<")
    expect(html).toContain("3 of 10 saved before the backup stopped.")
    expect(html).not.toContain("could not be saved")
    expect(html).toContain("bg-red-50")
    // While the run goes on, a failed item is an ordinary failure, not a stop.
    const running = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, status: "Running", isComplete: false, results: stopped } }))
    expect(running).toContain("1 of 10 could not be saved.")
    expect(running).not.toContain("before the backup stopped")
  })

  it("keeps an inventory type a stopped run did not finish as a stopped row, saved or not", () => {
    for (const saved of [0, 40]) {
      const results: Results = { types: [type("Autopilot", { label: "Windows Autopilot devices", inventory: true, state: "reading", found: 200, saved })], notices: [] }
      const summary = summarizeBackupResults(results, true)
      expect(summary.rows.map((entry) => entry.folder)).toEqual(["Autopilot"])
      expect(summary.inventory).toEqual([])
      const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, status: "Cancelled", results } }))
      expect(html).toContain(`${saved} of 200 saved before the backup stopped.`)
      expect(html).toContain(`${saved} of 200`)
      expect(html).not.toContain("Also saved")
    }
  })

  it("uses the error tone when a completed run had a read failure", () => {
    const unreadable: Results = { types: [type("A", { found: 1, saved: 1 }), type("B", { state: "unreadable", reason: "Graph returned 500" })], notices: [] }
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: unreadable } }))
    expect(html).toContain('data-notice-tone="error"')
  })

  it("announces a type where nothing was saved as none saved", () => {
    const none: Results = { types: [type("A", { found: 2, saved: 0, failed: 2 })], notices: [] }
    expect(renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: none } }))).toContain("none saved, 2 failed")
  })

  it("separates missing access, read failures and item save failures", () => {
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: { ...results, coverage: "incomplete" as const } } }))
    expect(html).toContain("Needs access for 1 type. 1 type could not be read. 1 item could not be saved.")
    const one: Results = { types: [type("A", { found: 1, saved: 1 }), type("B", { label: "scripts", state: "skipped", reason: "No permission." })], notices: [], coverage: "incomplete" }
    const compact = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: one }, compact: true }))
    expect(compact).toContain("Needs access for 1 type.")
    expect(compact).toContain('data-notice-tone="neutral"')
  })

  it("says nothing about coverage while the backup runs, when it is complete, or for results that do not record it", () => {
    const running = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, isComplete: false, results: { ...results, coverage: "incomplete" as const } } }))
    expect(running).not.toContain("Coverage incomplete")
    expect(renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: { ...results, coverage: "complete" as const } } }))).not.toContain("Coverage incomplete")
    expect(renderToStaticMarkup(createElement(BackupResults, { job }))).not.toContain("Coverage incomplete")
  })

  it("groups types the tenant never set up among the types with nothing to save", () => {
    const unset: Results = { types: [type("A", { found: 1, saved: 1 }), type("B", { label: "federated token validation policy", state: "notConfigured" }), type("C", { label: "access review policy", state: "notConfigured" })], notices: [], coverage: "complete" }
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: unset } }))
    expect(html).toContain("2 types had nothing to back up.")
    expect(html).not.toContain("Needs attention")
    expect(html).toContain("Not set up in this tenant.")
    const summary = summarizeBackupResults(unset, true)
    expect(summary.notConfigured.map((entry) => entry.folder)).toEqual(["B", "C"])
    expect(summary.coverageGap).toBeUndefined()
    expect(summary.typesBackedUp).toBe(1)
  })

  it("words a type whose read was refused part way as not read in full, with what it saved", () => {
    const partWay: Results = { types: [type("A", { label: "administrative units", state: "skipped", found: 20, saved: 2, reason: "Microsoft refused the read." })], notices: [], coverage: "incomplete" }
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: partWay } }))
    expect(html).toContain("Needs access. 2 saved before access was lost.")
    expect(html).not.toContain("Administrative units left out")
  })

  it("offers only the raw log when the job has no per type results", () => {
    const html = renderToStaticMarkup(createElement(BackupResults, { job: { ...job, results: undefined } }))
    expect(html).toContain("Show raw log")
    expect(html).not.toContain("Policies saved")
  })
})
