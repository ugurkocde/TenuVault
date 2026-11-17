import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { DriftResult } from "../src/shared/intune/drift"
import type { ReportAudit, ReportOptions } from "../src/shared/reports/change-report"
import { buildChangeReport, changeReportJson, changeReportMarkdown } from "../src/shared/reports/change-report"
import { buildChangeReportDocument } from "../src/shared/reports/change-report-html"
import fixture from "./fixtures/reports/ordinary-report-input.json"

// Expected exports were generated with the report builders at 66d9c77e. Keep their bytes
// unchanged: inventory reporting must not change ordinary desktop or cloud exports.
describe.each([false, true])("ordinary report compatibility (cloud: %s)", cloud => {
  it.each([false, true])("preserves JSON, Markdown and HTML from 66d9c77e (empty: %s)", empty => {
    const report = buildChangeReport(
      { ...fixture.drift, drifts: empty ? [] : fixture.drift.drifts } as DriftResult,
      { changes: empty ? [] : fixture.changes } as ReportAudit,
      { ...fixture.options, cloud } as ReportOptions,
    )
    const stem = `./fixtures/reports/ordinary-66d9c77e-${cloud ? "cloud" : "desktop"}-${empty ? "empty" : "changed"}`
    const expected = (extension: string) => readFileSync(new URL(`${stem}.${extension}`, import.meta.url), "utf8")
    expect(changeReportJson(report)).toBe(expected("json"))
    expect(changeReportMarkdown(report)).toBe(expected("md"))
    expect(buildChangeReportDocument(report).html).toBe(expected("html"))
  })
})
