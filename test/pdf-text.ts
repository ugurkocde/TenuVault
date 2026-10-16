import { inflateSync } from "node:zlib"
import { expect } from "vitest"

/** Text and geometry helpers for the PDF report tests. */

const MM = 72 / 25.4
const PAGE_HEIGHT = 297 * MM
// Body text sits between the header rule (14.6 mm from the top) and the footer rule (14.5 mm from the bottom).
const HEADER_RULE = PAGE_HEIGHT - 14.6 * MM
const FOOTER_RULE = 14.5 * MM
const LEFT = 15 * MM
const RIGHT = 195 * MM

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
export const positions = (stream: string) => [...stream.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) Td/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
export const outlineTitles = (bytes: Uint8Array) => [...Buffer.from(bytes).toString("latin1").matchAll(/\/Title \(((?:\\.|[^\\)])*)\)\s*\/Parent/g)].map(match => match[1]!.replace(/\\([()\\])/g, "$1"))
export const linkCount = (bytes: Uint8Array) => (Buffer.from(bytes).toString("latin1").match(/\/Subtype \/Link[^>]*\/Dest \[/g) ?? []).length

/** The first file id string of the trailer. */
export const fileId = (bytes: Uint8Array) => /\/ID \[ <([0-9A-F]+)>/.exec(Buffer.from(bytes).toString("latin1"))?.[1]

/** Every text position lies inside the page grid: header and footer lines in their bands, body text between the rules. */
export function expectInsideGrid(bytes: Uint8Array) {
  pageStreams(bytes).forEach((stream, index) => {
    for (const { x, y } of positions(stream)) {
      expect(x, `page ${index + 1}`).toBeGreaterThanOrEqual(LEFT - 0.5)
      expect(x, `page ${index + 1}`).toBeLessThanOrEqual(RIGHT + 0.5)
      expect(y, `page ${index + 1}`).toBeGreaterThanOrEqual(0)
      const footer = y < FOOTER_RULE - 6
      const header = y > HEADER_RULE + 4
      if (index > 0 && !footer && !header) {
        expect(y, `page ${index + 1}`).toBeGreaterThan(FOOTER_RULE)
        expect(y, `page ${index + 1}`).toBeLessThan(HEADER_RULE)
      }
    }
  })
}

