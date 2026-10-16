import { inflateSync } from "node:zlib"
import { expect } from "vitest"

/** Text and geometry helpers for the PDF report tests. */

const MM = 72 / 25.4
const PAGE_HEIGHT_MM = 297
// The page grid of layout.ts in mm from the top: header rule, body bottom, footer rule and the cover footer line.
const HEADER_RULE = 14.6
const CONTENT_BOTTOM = 276
const FOOTER_RULE = PAGE_HEIGHT_MM - 14.5
const COVER_BODY_BOTTOM = 283
const LEFT = 15
const RIGHT = 195

/** Decompressed content stream of every page, in page order. */
export function pageStreams(bytes: Uint8Array): string[] {
  const pdf = Buffer.from(bytes)
  const source = pdf.toString("latin1")
  const stream = (id: number) => {
    const start = source.search(new RegExp(`(^|\\s)${id} 0 obj`))
    const dataStart = source.indexOf("stream\n", start) + "stream\n".length
    const length = Number(/\/Length\s+(\d+)/.exec(source.slice(start, dataStart))?.[1] ?? 0)
    return inflateSync(pdf.subarray(dataStart, dataStart + length)).toString("latin1")
  }
  return [...source.matchAll(/\d+ 0 obj\s*<<\s*\/Type \/Page\b(?!s)/g)].map(match => {
    const contents = /\/Contents (\d+) 0 R/.exec(source.slice(match.index, source.indexOf("endobj", match.index)))?.[1]
    return contents ? stream(Number(contents)) : ""
  })
}

export const shown = (stream: string) => (stream.match(/\((?:\\.|[^\\()])*\)\s*Tj/g) ?? []).map(chunk => chunk.replace(/\)\s*Tj$/, "").slice(1).replace(/\\([()\\])/g, "$1"))
export const pdfText = (bytes: Uint8Array) => pageStreams(bytes).flatMap(shown).join(" ").replace(/\s+/g, " ")
export const outlineTitles = (bytes: Uint8Array) => [...Buffer.from(bytes).toString("latin1").matchAll(/\/Title \(((?:\\.|[^\\)])*)\)\s*\/Parent/g)].map(match => match[1]!.replace(/\\([()\\])/g, "$1"))
export const linkCount = (bytes: Uint8Array) => (Buffer.from(bytes).toString("latin1").match(/\/Subtype \/Link[^>]*\/Dest \[/g) ?? []).length

/** The first file id string of the trailer. */
export const fileId = (bytes: Uint8Array) => /\/ID \[ <([0-9A-F]+)>/.exec(Buffer.from(bytes).toString("latin1"))?.[1]

/** Every drawn string with its start point in mm, measured from the top left corner of the page. */
export const textRuns = (stream: string) => [...stream.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) Td\s*\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
  .map(match => ({ x: Number(match[1]) / MM, y: PAGE_HEIGHT_MM - Number(match[2]) / MM, text: match[3]!.replace(/\\([()\\])/g, "$1") }))

/** Body text of pages 2 to N without running headers, footers and "(continued)" captions, so text split across pages reads as one. */
export const bodyText = (bytes: Uint8Array) => pageStreams(bytes).slice(1).flatMap(stream => textRuns(stream))
  .filter(run => run.y > HEADER_RULE && run.y < FOOTER_RULE && !run.text.endsWith("(continued)")).map(run => run.text).join(" ")

export interface GridExpectation {
  /** Running header strings: the report short name and the tenant. */
  header: string[]
  /** Running footer, left. */
  footer: string
  /** The two footer strings of the cover. */
  coverFooter: [string, string]
}

/** A drawn label is the expected text, or the expected text shortened with an ellipsis. */
const isLabel = (text: string, expected: readonly string[]) => expected.some(value => value === text || (text.endsWith("...") && value.startsWith(text.slice(0, -3).trimEnd())))

/**
 * Every string lies inside the page grid. On pages 2 to N the header band holds only the header
 * strings, the footer band only the footer text and "Page X of Y", and every other baseline sits
 * between the header rule and the bottom of the body. On the cover only its two footer strings may
 * sit below the body. Nothing starts outside the side margins.
 */
export function expectInsideGrid(bytes: Uint8Array, expected: GridExpectation) {
  const pages = pageStreams(bytes)
  pages.forEach((stream, index) => {
    const page = `page ${index + 1}`
    const runs = textRuns(stream)
    // Every shown string has a start point, so none escapes the checks below.
    expect(runs.length, page).toBe(shown(stream).length)
    for (const { x, y, text } of runs) {
      const where = `${page}: ${JSON.stringify(text.slice(0, 60))} at ${x.toFixed(1)}, ${y.toFixed(1)} mm`
      expect(x, where).toBeGreaterThanOrEqual(LEFT - 0.5)
      expect(x, where).toBeLessThanOrEqual(RIGHT + 0.5)
      if (index === 0) {
        if (y > COVER_BODY_BOTTOM) expect(isLabel(text, expected.coverFooter), where).toBe(true)
        continue
      }
      if (y < HEADER_RULE) expect(isLabel(text, expected.header), where).toBe(true)
      else if (y > FOOTER_RULE) expect(isLabel(text, [expected.footer, `Page ${index + 1} of ${pages.length}`]), where).toBe(true)
      else expect(y, where).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.01)
    }
    if (index > 0) {
      const footer = runs.filter(run => run.y > FOOTER_RULE).map(run => run.text)
      expect(footer, page).toContain(`Page ${index + 1} of ${pages.length}`)
      expect(footer.some(text => isLabel(text, [expected.footer])), page).toBe(true)
    }
  })
}
