import { inflateSync } from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CIS_CERTIFIED_CHECK_COUNTS, CIS_CERTIFIED_SEGMENTS, CIS_REMEDIATION_LIMITS, cisCheckCount, cisCheckCountText, certifiedScopeLines } from "../src/shared/frameworks/cis-certification"
import { CIS_SAMPLE_FILE_NAME, CIS_SAMPLE_MARKER, CIS_SAMPLE_NOTE, CIS_SAMPLE_TITLE, cisSampleSummary, generateCisSampleReportPDF } from "../src/shared/compliance/cis-sample-report"
import { MANUAL_RECOMMENDATIONS_FALLBACK, MANUAL_RECOMMENDATIONS_URL } from "../src/shared/frameworks/cis-manual"
import { handleFramework, setFrameworkExportSaver, type ExportFile } from "../src/main/frameworks/service"
import { requiredFeatures } from "../src/main/api/plan-gates"
import { prepareGeneratedFile } from "../src/main/save-file"
import { cisSummary } from "./pdf-report-fixtures"

/** The text each page of a PDF shows, joined with single spaces, one entry per page content stream. */
function pageTexts(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes).toString("latin1")
  const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(match => {
    try { return inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1") } catch { return match[1]! }
  })
  return streams.map(stream => (stream.match(/\((?:\\.|[^\\()])*\)\s*Tj/g) ?? []).map(chunk => chunk.replace(/\)\s*Tj$/, "").slice(1).replace(/\\([()\\])/g, "$1")).join(" ").replace(/\s+/g, " "))
}
const pageCount = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1").match(/\/Type \/Page\b(?!s)/g)?.length ?? 0

describe("certified check counts", () => {
  it("gives every certified benchmark Level a count, and nothing outside the certified scope", () => {
    const segments = CIS_CERTIFIED_SEGMENTS.flatMap(segment => segment.levels.map(level => `${segment.benchmark} ${segment.version} ${level}`))
    expect(CIS_CERTIFIED_CHECK_COUNTS.map(count => `${count.benchmark} ${count.version} ${count.level}`).sort()).toEqual(segments.sort())
    for (const segment of CIS_CERTIFIED_SEGMENTS) for (const level of segment.levels) expect(cisCheckCount(segment.benchmark, segment.version, level), `${segment.benchmark} Level ${level}`).toBeDefined()
    expect(cisCheckCount("intune-windows11", "5.0.0", 2)).toBeUndefined()
    expect(cisCheckCount("intune-windows11", "4.0.0", 1)).toBeUndefined()
  })

  it("keeps every count sane: whole numbers, at least one automatic check, never more automatic checks than recommendations", () => {
    for (const count of CIS_CERTIFIED_CHECK_COUNTS) {
      expect(Number.isInteger(count.automated) && Number.isInteger(count.total), count.benchmark).toBe(true)
      expect(count.automated).toBeGreaterThan(0)
      expect(count.automated).toBeLessThanOrEqual(count.total)
    }
    expect(CIS_CERTIFIED_CHECK_COUNTS.map(count => [count.benchmark, count.level, count.automated, count.total])).toEqual([
      ["intune-windows11", 1, 274, 308], ["intune-for-defender", 1, 52, 52], ["intune-for-defender", 2, 3, 3], ["mac-os-26", 1, 88, 90], ["mac-os-26", 2, 10, 10],
    ])
  })

  it("says how many are checked automatically and that the rest are listed for a manual check", () => {
    expect(cisCheckCountText({ automated: 274, total: 308 })).toBe("TenuVault checks 274 of 308 recommendations automatically; the rest are listed for a manual check.")
    expect(cisCheckCountText({ automated: 52, total: 52 })).toBe("TenuVault checks all 52 recommendations automatically.")
  })

  it("writes the counts and the sample note in plain words, without dashes used as punctuation", () => {
    for (const text of [...CIS_CERTIFIED_CHECK_COUNTS.map(count => cisCheckCountText(count)), CIS_SAMPLE_NOTE]) {
      expect(text).not.toMatch(/[\u2013\u2014]/)
      expect(text).not.toContain(" - ")
    }
  })
})

describe("sample CIS readiness report", () => {
  const bytes = generateCisSampleReportPDF()
  const pages = pageTexts(bytes)
  const text = pages.join(" ")

  it("generates a PDF of about 15 pages", () => {
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-")
    expect(pageCount(bytes)).toBeGreaterThanOrEqual(13)
    expect(pageCount(bytes)).toBeLessThanOrEqual(17)
    expect(pages).toHaveLength(pageCount(bytes))
  })

  it("marks every page as sample data and says on the cover what the sample is", () => {
    pages.forEach((page, index) => expect(page, `page ${index + 1}`).toContain(CIS_SAMPLE_MARKER))
    expect(pages[0]).toContain(CIS_SAMPLE_TITLE)
    expect(pages[0]).toContain("Contoso (sample)")
    // The cover lead wraps, so its words are checked without the line breaks.
    expect(pages[0]!.replace(/\s+/g, "")).toContain(CIS_SAMPLE_NOTE.replace(/\s+/g, ""))
    expect(Buffer.from(bytes).toString("latin1")).toContain(`/Title (${CIS_SAMPLE_TITLE})`)
  })

  it("shows the real report features: readiness per Level, coverage, recommendation results with remediation labels, manual and not assessed items, certification, limits and the CIS notice", () => {
    for (const level of [1, 2]) {
      expect(text).toContain(`Level ${level} readiness`)
      expect(text).toContain(`Recommendation results, Level ${level}`)
      expect(text).toContain(`Manual recommendations, Level ${level}`)
      expect(text).toContain(`Not assessed by this tool, Level ${level}`)
    }
    expect(text).toContain("Coverage:")
    expect(text).toContain("Recommendation pass rate")
    expect(text).toContain("Remediation: by TenuVault")
    expect(text).toContain("Remediation: partly by TenuVault, partly manual action")
    expect(text).toContain("Remediation: manual action")
    expect(text).toContain("Accepted exceptions, Level 1")
    expect(text).toContain("TenuVault is CIS Benchmarks Certified for Assessment and Remediation.")
    for (const line of certifiedScopeLines()) expect(text).toContain(line)
    expect(text).toContain("Level 1 is within the certified scope")
    expect(text).toContain("Limits of remediation")
    expect(text.replace(/\s+/g, "")).toContain(CIS_REMEDIATION_LIMITS[3]!.replace(/\s+/g, ""))
    expect(text.replace(/\s+/g, "")).toContain(MANUAL_RECOMMENDATIONS_FALLBACK.replace(/\s+/g, ""))
    expect(text).toContain(MANUAL_RECOMMENDATIONS_URL)
  })

  it("holds only synthetic recommendations: placeholder ids, titles and text", () => {
    const summary = cisSampleSummary()
    expect(summary.benchmark).toBe("intune-windows11")
    expect(summary.version).toBe("5.0.0")
    for (const level of summary.levels) {
      expect(level.recommendations.length).toBeGreaterThan(0)
      for (const result of level.recommendations) {
        expect(result.id).toMatch(/^S[12]\.\d+$/)
        expect(result.title).toMatch(/^Sample recommendation: example setting /)
        for (const setting of result.settings) expect(setting.id).toMatch(/^sample_setting_s[12]_/)
      }
      expect(level.manual.some(item => item.state === "Manual")).toBe(true)
      expect(level.manual.some(item => item.state === "Not assessed")).toBe(true)
      for (const item of level.manual) {
        // Pack recommendations that name a setting outside the pack are listed as not assessed too.
        expect(item.identifier).toMatch(/^S[12]\.[MN]?\d+$/)
        if (item.title) expect(item.title).toMatch(/^Sample (manual )?recommendation: example /)
        for (const value of [item.description, item.impact, item.audit, item.remediation]) if (value) expect(value).toMatch(/^Placeholder /)
      }
    }
  })

  it("contains no text from the CIS report fixtures", () => {
    const fixture = cisSummary({ extreme: true })
    const strings = fixture.levels.flatMap(level => [
      ...level.recommendations.flatMap(result => [result.title, ...result.settings.map(setting => setting.id)]),
      ...level.manual.flatMap(item => [item.title, item.description, item.impact, item.audit, item.remediation]),
      ...level.exceptions.flatMap(exception => [exception.owner, exception.reason.trim(), exception.policyName]),
      ...level.notAssessed,
    ]).filter((value): value is string => !!value && value.length > 4)
    for (const value of new Set(strings)) expect(text, value).not.toContain(value)
    expect(text).not.toContain("Contoso Ltd")
    expect(text).not.toContain(fixture.benchmark)
  })
})

describe("sample report request", () => {
  afterEach(() => setFrameworkExportSaver(null))

  it("needs no plan and names no tenant or CIS framework", () => {
    expect(requiredFeatures("/api/frameworks", { action: "cis-sample-pdf", save: "dialog" })).toEqual([])
  })

  it("builds the sample in main and saves it through the Save dialog, without reading any workspace or content", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const saved: ExportFile[] = []
    setFrameworkExportSaver(async file => { saved.push(file); const prepared = prepareGeneratedFile(file.data, file.name, file.encoding); return { saved: true, path: `/tmp/${prepared.name}` } })
    const outcome = await handleFramework({ action: "cis-sample-pdf", save: "dialog" })
    expect(outcome).toEqual({ name: CIS_SAMPLE_FILE_NAME, saved: true, path: `/tmp/${CIS_SAMPLE_FILE_NAME}` })
    expect(saved).toHaveLength(1)
    expect(saved[0]!.type).toBe("application/pdf")
    expect(Buffer.from(saved[0]!.data, "base64").subarray(0, 5).toString("latin1")).toBe("%PDF-")
    // Nothing is fetched: no delivery service, no Graph.
    expect(fetch).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
