import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { DriftResult } from "../src/shared/intune/drift"
import type { ReportAudit, ReportOptions } from "../src/shared/reports/change-report"
import { buildChangeReport, changeReportJson, changeReportMarkdown, reportHasNoChanges, summaryLine } from "../src/shared/reports/change-report"
import { buildChangeReportDocument } from "../src/shared/reports/change-report-html"
import fixture from "./fixtures/reports/ordinary-report-input.json"

// Expected exports were generated with the report builders at 66d9c77e. Keep their bytes
// unchanged: inventory reporting must not change ordinary desktop or cloud exports.
describe.each([false, true])("ordinary report compatibility (cloud: %s)", cloud => {
  it.each([[false, false], [true, false], [false, true], [true, true]])("preserves JSON, Markdown and HTML from 66d9c77e (empty: %s, unreadable: %s)", (empty, unreadable) => {
    const report = buildChangeReport(
      { ...fixture.drift, drifts: empty ? [] : fixture.drift.drifts, warnings: unreadable ? [{ file: "policy.json", backup: "older", message: "unreadable" }] : [] } as DriftResult,
      { changes: empty ? [] : fixture.changes } as ReportAudit,
      { ...fixture.options, cloud } as ReportOptions,
    )
    const stem = `./fixtures/reports/ordinary-66d9c77e-${cloud ? "cloud" : "desktop"}-${empty ? "empty" : "changed"}`
    const expected = (extension: string) => readFileSync(new URL(`${stem}.${extension}`, import.meta.url), "utf8")
    // The warning blocks are unchanged since the base. Add them to the frozen ordinary
    // output to also prove that incomplete reads retain their original export wording.
    const json = JSON.parse(expected("json"))
    if (unreadable) json.warnings = ["policy.json (older): unreadable"]
    const markdown = expected("md").trimEnd() + (unreadable ? "\n\n## Not compared\n\n- policy.json \\(older\\): unreadable" : "") + "\n"
    const html = unreadable ? expected("html").replace('<p class="provenance">', '<section><h2>Not compared</h2><ul class="activity"><li>policy.json (older): unreadable</li></ul></section><p class="provenance">') : expected("html")
    if (unreadable) {
      expect(reportHasNoChanges(report)).toBe(false)
      expect(summaryLine(report)).toContain("ordinary comparison was incomplete")
    }
    expect(changeReportJson(report)).toBe(JSON.stringify(json, null, 2))
    expect(changeReportMarkdown(report)).toBe(markdown)
    expect(buildChangeReportDocument(report).html).toBe(html)
  })
})
