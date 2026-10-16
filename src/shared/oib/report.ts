/** OpenIntuneBaseline reports: plain text tables the main process turns into a PDF, and CSV exports. */

export interface ReportSection {
  heading: string
  note?: string
  columns: string[]
  rows: string[][]
}

export interface Report {
  title: string
  subtitle?: string
  /** Small uppercase line above the title on the cover. */
  eyebrow?: string
  meta: Array<[string, string]>
  summary?: Array<[string, string]>
  sections: ReportSection[]
  /** Licence and attribution of the content, printed verbatim at the end. */
  attribution?: string
}

/** A report as the renderer sends it: the tenant it describes decides the plan, and so the branding. */
export interface ReportPayload extends Report {
  tenantId: string
}

export type StatusTone = "good" | "different" | "missing" | "conflict" | "neutral"

/** Status words the OIB reports print, shown as pills with a marker shape so status never relies on colour alone. */
const STATUS_TONES: Record<string, StatusTone> = {
  "Matches the baseline": "good",
  "Match the baseline": "good",
  "Up to date": "good",
  "Drift detected": "different",
  "Value mismatch": "different",
  "Update available": "different",
  "Missing in tenant": "missing",
  "New policy": "missing",
  "Validation error": "conflict",
  "Error": "conflict",
  "Errors": "conflict",
  "Ambiguous match": "conflict",
  "Not validated": "neutral",
  "Only in tenant": "neutral",
  "Newer than OIB": "neutral",
}

/** The tone of a known status word, or undefined for any other text. */
export const statusTone = (value: string): StatusTone | undefined => Object.hasOwn(STATUS_TONES, value.trim()) ? STATUS_TONES[value.trim()] : undefined

/** Limits of a report sent over IPC; the old HTML path capped the document at 25 million characters. */
export const REPORT_LIMITS = { characters: 10_000_000, sections: 1_000, rows: 25_000, columns: 12, meta: 24, summary: 12, cell: 20_000, label: 300 } as const

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

class ReportShapeError extends Error {
  constructor(reason: string) {
    super(`The report could not be prepared: ${reason}.`)
    this.name = "ReportShapeError"
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Checks a report sent by the renderer before anything is generated: only the known fields, only
 * strings where text is expected, every row as wide as its columns and the sizes capped. Returns a
 * copy with exactly those fields; throws on anything else.
 */
export function parseReportPayload(value: unknown): ReportPayload {
  if (!isRecord(value)) throw new ReportShapeError("the report is missing")
  const allowed = new Set(["tenantId", "title", "subtitle", "eyebrow", "meta", "summary", "sections", "attribution"])
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown) throw new ReportShapeError(`unknown field ${unknown.slice(0, 40)}`)
  let characters = 0
  const text = (input: unknown, field: string, max: number, optional = false): string | undefined => {
    if (input === undefined && optional) return undefined
    if (typeof input !== "string") throw new ReportShapeError(`${field} must be text`)
    if (input.length > max) throw new ReportShapeError(`${field} is too long`)
    characters += input.length
    if (characters > REPORT_LIMITS.characters) throw new ReportShapeError("the report is too large")
    return input
  }
  const pairs = (input: unknown, field: string, max: number, valueMax: number): Array<[string, string]> => {
    if (!Array.isArray(input) || input.length > max) throw new ReportShapeError(`${field} must be a list of at most ${max} entries`)
    return input.map((pair, index) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new ReportShapeError(`${field} entry ${index + 1} must be a label and a value`)
      return [text(pair[0], field, REPORT_LIMITS.label)!, text(pair[1], field, valueMax)!]
    })
  }
  if (typeof value.tenantId !== "string" || !GUID.test(value.tenantId)) throw new ReportShapeError("the tenant ID is invalid")
  const title = text(value.title, "title", REPORT_LIMITS.label)!
  if (!title.trim()) throw new ReportShapeError("title is empty")
  // The subtitle lists the pack reference of every platform compared.
  const subtitle = text(value.subtitle, "subtitle", 2_000, true)
  const eyebrow = text(value.eyebrow, "eyebrow", 120, true)
  const attribution = text(value.attribution, "attribution", 2_000, true)
  const meta = pairs(value.meta, "meta", REPORT_LIMITS.meta, 2_000)
  const summary = value.summary === undefined ? undefined : pairs(value.summary, "summary", REPORT_LIMITS.summary, 40)
  if (!Array.isArray(value.sections) || value.sections.length > REPORT_LIMITS.sections) throw new ReportShapeError("sections must be a list")
  let rows = 0
  const sections = value.sections.map((section: unknown, index): ReportSection => {
    const field = `section ${index + 1}`
    if (!isRecord(section)) throw new ReportShapeError(`${field} is invalid`)
    const extra = Object.keys(section).find(key => !["heading", "note", "columns", "rows"].includes(key))
    if (extra) throw new ReportShapeError(`${field} has an unknown field ${extra.slice(0, 40)}`)
    const heading = text(section.heading, `${field} heading`, REPORT_LIMITS.label)!
    const note = text(section.note, `${field} note`, 2_000, true)
    if (!Array.isArray(section.columns) || !section.columns.length || section.columns.length > REPORT_LIMITS.columns) throw new ReportShapeError(`${field} must have 1 to ${REPORT_LIMITS.columns} columns`)
    const columns = section.columns.map(column => text(column, `${field} column`, 120)!)
    if (!Array.isArray(section.rows)) throw new ReportShapeError(`${field} rows must be a list`)
    rows += section.rows.length
    if (rows > REPORT_LIMITS.rows) throw new ReportShapeError(`the report has more than ${REPORT_LIMITS.rows} rows`)
    const cells = section.rows.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new ReportShapeError(`every row of ${field} must have ${columns.length} cells`)
      return row.map(cell => text(cell, `${field} cell`, REPORT_LIMITS.cell)!)
    })
    return { heading, ...(note !== undefined && { note }), columns, rows: cells }
  })
  return {
    tenantId: value.tenantId.toLowerCase(), title,
    ...(subtitle !== undefined && { subtitle }), ...(eyebrow !== undefined && { eyebrow }),
    meta, ...(summary && { summary }), sections, ...(attribution !== undefined && { attribution }),
  }
}

/** CSV with every cell quoted; cells that a spreadsheet would run as a formula are prefixed with '. */
export function toCsv(rows: string[][]): string {
  const cell = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
    return `"${safe.replace(/"/g, '""')}"`
  }
  return rows.map((row) => row.map(cell).join(",")).join("\r\n")
}
