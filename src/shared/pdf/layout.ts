import { jsPDF } from 'jspdf'
import type { BrandTheme } from './theme'
import { PALETTE, capHeight, clampLine, drawCard, drawEyebrow, drawRule, fingerprint, setFont, textWidth, wrapLines, type FontStyle, type RgbColor } from './kit'

/**
 * Paging engine of the TenuVault reports: an A4 grid, top-of-line text drawing, cards that
 * continue across pages, a contents page filled in after layout with clickable rows, deferred
 * page references, bookmarks and the running header and footer on every page after the cover.
 */

export const PAGE = { width: 210, height: 297, margin: 15, right: 195, contentWidth: 180, contentTop: 21, contentBottom: 276 } as const

/** One run of text: wrapped to its column and drawn with these attributes. */
export interface TextItem {
  text: string
  size?: number
  style?: FontStyle
  color?: RgbColor
  /** Identifiers, URLs and JSON: also break after punctuation and between characters. */
  technical?: boolean
  lineHeight?: number
  /** Space above this item, in mm. */
  gap?: number
}

/** A wrapped line ready to draw. `height` includes the gap above it. */
export interface Line {
  text: string
  size: number
  style: FontStyle
  color: RgbColor
  height: number
  /** Space above the line, included in its height. */
  gap: number
  offset: number
}

/** A pre-measured piece of a flow. `keep` is the extra height that must fit with it on the page. */
export interface FlowBlock {
  height: number
  keep?: number
  draw: (top: number) => void
}

export interface TocEntry {
  title: string
  page: number
  level: 0 | 1
}

export interface LayoutOptions {
  /** Running header, left. */
  shortName: string
  /** Running header, right. */
  tenant?: string
  /** Footer, left, after "TenuVault | ". */
  footer: string
  /** Applied to every string measured or drawn. */
  sanitize: (value: string) => string
  properties: { title: string; subject: string; keywords: string }
  /** The export time: the PDF creation date, so the same export yields the same bytes. */
  exportedAt: string
  /** The inputs of the report; their fingerprint becomes the PDF file id. */
  identity: string
  theme: BrandTheme
}

// The longest piece of a block, so a block never outgrows a page.
const MAX_CHUNK = 96

export type Layout = ReturnType<typeof createLayout>

export function createLayout(options: LayoutOptions) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const { sanitize, theme } = options
  // White label reports name the customer wherever TenuVault would appear, except in verbatim legal text.
  let verbatim = false
  const company = theme.companyName && !/tenuvault/i.test(theme.companyName) ? theme.companyName : undefined
  // Idempotent: cleaning a cleaned string changes nothing, so measured and drawn text agree.
  const clean = (value: string) => {
    const safe = sanitize(value)
    return verbatim || !company ? safe : safe.replace(/\bTenuVault\b/g, () => company)
  }
  // One choke point: every string jsPDF measures, wraps or draws is cleaned first, so the
  // measured width is always the width of the drawn text.
  const text = doc.text.bind(doc)
  const getTextWidth = doc.getTextWidth.bind(doc)
  const splitTextToSize = doc.splitTextToSize.bind(doc)
  doc.text = ((value: string | string[], x: number, y: number, textOptions?: Parameters<typeof text>[3]) =>
    text(Array.isArray(value) ? value.map(clean) : clean(value), x, y, textOptions)) as typeof doc.text
  doc.getTextWidth = (value: string) => getTextWidth(clean(value))
  doc.splitTextToSize = (value: string, width: number, splitOptions?: unknown) => splitTextToSize(clean(value), width, splitOptions)
  const publisher = theme.companyName ?? 'TenuVault'
  doc.setProperties({ ...options.properties, author: publisher, creator: publisher })

  const { margin, right, contentWidth, contentTop, contentBottom } = PAGE
  let y: number = contentTop
  let tocPage = 0
  let tocTop: number = contentTop
  const toc: TocEntry[] = []
  const anchors = new Map<string, number>()
  const refs: { page: number; x: number; y: number; key: string; size: number; color: RgbColor; format: (page: number) => string }[] = []
  const links: { page: number; x: number; top: number; width: number; height: number; key: string }[] = []

  const page = () => doc.getCurrentPageInfo().pageNumber
  /** Footer text: TenuVault and the report name, or the customer's footer text or name on a white label report. */
  const footerLeft = () => theme.companyName ? theme.footerText ?? theme.companyName : `TenuVault | ${options.footer}`

  function addPage() {
    doc.addPage()
    y = contentTop
  }

  /** Starts a new page when the height does not fit; true when it did. */
  function ensure(height: number): boolean {
    if (y + height <= contentBottom || y <= contentTop) return false
    addPage()
    return true
  }

  function wrap(value: string, width: number, size = 9, style: FontStyle = 'normal', wrapOptions: { technical?: boolean; maxLines?: number } = {}): string[] {
    return wrapLines(doc, clean(value), width, size, style, wrapOptions)
  }

  /** Wraps text items into lines for a column of the given width. */
  function measure(items: readonly TextItem[], width: number): Line[] {
    const lines: Line[] = []
    let offset = 0
    for (const item of items) {
      const size = item.size ?? 8
      const style = item.style ?? 'normal'
      const lineHeight = item.lineHeight ?? size * 0.43
      wrap(item.text, width, size, style, { technical: item.technical }).forEach((line, index) => {
        const gap = index === 0 ? item.gap ?? 0 : 0
        lines.push({ text: line, size, style, color: item.color ?? PALETTE.ink, height: lineHeight + gap, gap, offset: offset + gap })
        offset += lineHeight + gap
      })
    }
    return lines
  }

  const heightOf = (lines: readonly Line[]) => lines.reduce((sum, line) => sum + line.height, 0)

  /** Draws measured lines from `top`; each line's top is its offset from the first line. */
  function drawLines(lines: readonly Line[], x: number, top: number, align: 'left' | 'right' | 'center' = 'left') {
    const base = lines[0]?.offset ?? 0
    for (const line of lines) {
      setFont(doc, line.size, line.style, line.color)
      doc.text(line.text, x, top + line.offset - base + capHeight(line.size), align === 'left' ? undefined : { align })
    }
  }

  /** Splits lines into pieces no taller than the page allows. */
  function chunk(lines: readonly Line[], limit = MAX_CHUNK): Line[][] {
    const chunks: Line[][] = [[]]
    let used = 0
    for (const line of lines) {
      if (used + line.height > limit && chunks[chunks.length - 1]!.length) {
        chunks.push([])
        used = 0
      }
      chunks[chunks.length - 1]!.push(line)
      used += line.height
    }
    return chunks
  }

  /** Text in the flow at the cursor, continuing on the next page when needed. */
  function paragraph(items: readonly TextItem[] | string, paragraphOptions: { x?: number; width?: number; after?: number; verbatim?: boolean } = {}) {
    verbatim = paragraphOptions.verbatim === true
    const x = paragraphOptions.x ?? margin
    const width = paragraphOptions.width ?? contentWidth
    const lines = measure(typeof items === 'string' ? [{ text: items, size: 8.6, color: PALETTE.body, lineHeight: 4 }] : items, width)
    for (const line of lines) {
      ensure(line.height)
      drawLines([{ ...line, offset: 0 }], x, y + line.gap)
      y += line.height
    }
    verbatim = false
    y += paragraphOptions.after ?? 0
  }

  /** Page title: eyebrow, large title and an optional lead; recorded in the contents. */
  function pageTitle(eyebrow: string, title: string, titleOptions: { lead?: string; newPage?: boolean; toc?: boolean } = {}) {
    if (titleOptions.newPage === false) {
      if (y > contentTop) y += 6
      ensure(48)
    } else if (y > contentTop || page() === 1 || page() === tocPage) addPage()
    if (titleOptions.toc !== false) toc.push({ title, page: page(), level: 0 })
    drawEyebrow(doc, eyebrow, margin, y + 2.4, { color: theme.accentText })
    let size = 20
    while (size > 12 && textWidth(doc, title, size, 'bold') > contentWidth) size -= 0.5
    setFont(doc, size, 'bold', theme.strong)
    doc.text(title, margin, y + 5.7 + capHeight(size))
    y += 8.5 + capHeight(size)
    if (titleOptions.lead) {
      const lines = measure([{ text: titleOptions.lead, size: 8.8, color: PALETTE.muted, lineHeight: 4 }], 160)
      drawLines(lines, margin, y + 0.5)
      y += heightOf(lines) + 1
    }
    y += 4
  }

  /** Section heading with an optional note on the right; kept with `keep` mm of what follows. */
  function heading(title: string, headingOptions: { note?: string; keep?: number; toc?: boolean; size?: number } = {}) {
    const size = headingOptions.size ?? 10.5
    ensure(6.5 + (headingOptions.keep ?? 18))
    if (headingOptions.toc) toc.push({ title, page: page(), level: 1 })
    setFont(doc, size, 'bold', theme.strong)
    const noteWidth = headingOptions.note ? textWidth(doc, headingOptions.note, 7) + 6 : 0
    doc.text(clampLine(doc, title, contentWidth - noteWidth, size, 'bold'), margin, y + capHeight(size))
    if (headingOptions.note) {
      setFont(doc, 7, 'normal', PALETTE.muted)
      doc.text(headingOptions.note, right, y + capHeight(size), { align: 'right' })
    }
    y += 6.5
  }

  function record(title: string, level: 0 | 1 = 1) {
    toc.push({ title, page: page(), level })
  }

  function anchor(key: string) {
    if (!anchors.has(key)) anchors.set(key, page())
  }

  /** A page number written after layout, when every page is known, with a link to that page. */
  function pageRef(key: string, x: number, baseline: number, refOptions: { size?: number; color?: RgbColor; format?: (page: number) => string } = {}) {
    refs.push({ page: page(), x, y: baseline, key, size: refOptions.size ?? 7.4, color: refOptions.color ?? theme.strong, format: refOptions.format ?? String })
  }

  /** A clickable area that opens the page recorded for `key`. */
  function link(key: string, x: number, top: number, width: number, height: number) {
    links.push({ page: page(), x, top, width, height, key })
  }

  function continuation(caption: string) {
    addPage()
    setFont(doc, 7.2, 'italic', PALETTE.muted)
    doc.text(clampLine(doc, `${caption} (continued)`, contentWidth, 7.2, 'italic'), margin, y + 2.6)
    y += 6
  }

  /**
   * Draws blocks at the cursor. A block that does not fit starts a new page with a continuation
   * caption; `repeat` may return a block (a table header) to draw again at the top. With `card`
   * every page segment gets its own border.
   */
  function flow(blocks: readonly FlowBlock[], flowOptions: { caption: string; repeat?: (index: number) => FlowBlock | undefined; card?: { dashed?: boolean } } = { caption: '' }) {
    const pad = flowOptions.card ? 3 : 0
    let segmentTop = y
    let fresh = true
    const close = () => {
      if (!flowOptions.card) return
      drawCard(doc, margin, segmentTop, contentWidth, y + pad - segmentTop, flowOptions.card.dashed ? { stroke: PALETTE.dashed, dashed: true } : { stroke: PALETTE.border })
      y += pad
    }
    blocks.forEach((block, index) => {
      const fits = y + block.height + (block.keep ?? 0) + pad <= contentBottom
      if (!fits && fresh && y > contentTop) {
        if (flowOptions.caption) continuation(flowOptions.caption)
        else addPage()
        segmentTop = y
      } else if (!fits && !fresh) {
        close()
        continuation(flowOptions.caption)
        segmentTop = y
        if (flowOptions.card) y += 1.5
        const repeated = flowOptions.repeat?.(index)
        if (repeated) {
          repeated.draw(y)
          y += repeated.height
        }
      }
      block.draw(y)
      y += block.height
      fresh = false
    })
    close()
  }

  /** Reserves the contents page after the cover; `intro` draws a panel above the contents. */
  function contentsPage(intro?: (top: number) => number) {
    addPage()
    tocPage = page()
    if (intro) y += intro(y) + 8
    tocTop = y
  }

  function drawContents(): number {
    const continuationTop = contentTop
    const rows = toc.map((entry, index) => {
      const size = entry.level === 1 ? 7.4 : 8.6
      const style: FontStyle = entry.level === 1 ? 'normal' : 'bold'
      const lines = wrap(entry.title, contentWidth - (entry.level === 1 ? 22 : 14), size, style)
      const gapBefore = entry.level === 0 && index > 0 ? 2.2 : 0
      return { entry, lines, size, style, gapBefore, height: gapBefore + lines.length * 3.6 + (entry.level === 0 ? 3.6 : 1.5), offset: 0, top: 0 }
    })
    let extra = 0
    let top = tocTop + 15
    for (const row of rows) {
      if (top + row.height > contentBottom) {
        extra++
        top = continuationTop + 15
      }
      row.offset = extra
      row.top = top
      top += row.height
    }
    for (const entry of toc) entry.page += entry.page > tocPage ? extra : 0
    for (const [key, value] of anchors) anchors.set(key, value > tocPage ? value + extra : value)
    for (const item of [...refs, ...links]) if (item.page > tocPage) item.page += extra
    for (let offset = 1; offset <= extra; offset++) doc.insertPage(tocPage + offset)
    for (let offset = 0; offset <= extra; offset++) {
      doc.setPage(tocPage + offset)
      const headingTop = offset === 0 ? tocTop : continuationTop
      setFont(doc, 20, 'bold', theme.strong)
      doc.text(offset === 0 ? 'Contents' : 'Contents (continued)', margin, headingTop + capHeight(20) + 1)
      drawRule(doc, margin, headingTop + capHeight(20) + 4.5, right, theme.strong, 0.4)
    }
    for (const row of rows) {
      doc.setPage(tocPage + row.offset)
      const top = row.top + row.gapBefore
      const x = margin + (row.entry.level === 1 ? 6 : 0)
      setFont(doc, row.size, row.style, row.entry.level === 1 ? PALETTE.body : PALETTE.ink)
      row.lines.forEach((line, index) => doc.text(line, x, top + 0.6 + capHeight(row.size) + index * 3.6))
      setFont(doc, row.size, 'bold', row.entry.level === 1 ? PALETTE.muted : theme.strong)
      doc.text(String(row.entry.page), right, top + 0.6 + capHeight(row.size), { align: 'right' })
      if (row.entry.level === 0) drawRule(doc, margin, top + row.lines.length * 3.6 + 1.7, right)
      doc.link(margin, top - 0.6, contentWidth, row.height - row.gapBefore, { pageNumber: row.entry.page })
    }
    return extra
  }

  /** Contents, page references, links, bookmarks, header and footer; then the PDF bytes. */
  function finish(): Uint8Array<ArrayBuffer> {
    if (tocPage) drawContents()
    for (const ref of refs) {
      const target = anchors.get(ref.key)
      if (target === undefined) continue
      doc.setPage(ref.page)
      setFont(doc, ref.size, 'bold', ref.color)
      const label = ref.format(target)
      doc.text(label, ref.x, ref.y, { align: 'right' })
      doc.link(ref.x - textWidth(doc, label, ref.size, 'bold'), ref.y - capHeight(ref.size) - 0.8, textWidth(doc, label, ref.size, 'bold'), capHeight(ref.size) + 1.6, { pageNumber: target })
    }
    for (const item of links) {
      const target = anchors.get(item.key)
      if (target === undefined) continue
      doc.setPage(item.page)
      doc.link(item.x, item.top, item.width, item.height, { pageNumber: target })
    }
    const sections: { title: string; page: number; children: { title: string; page: number }[] }[] = []
    for (const entry of toc) {
      if (entry.level === 0 || !sections.length) sections.push({ title: entry.title, page: entry.page, children: [] })
      else sections[sections.length - 1]!.children.push({ title: entry.title, page: entry.page })
    }
    const outlineTitle = (value: string) => clean(value).replace(/\s+/g, ' ').trim()
    if (tocPage) doc.outline.add(null, 'Contents', { pageNumber: tocPage })
    for (const section of sections) {
      const parent = doc.outline.add(null, outlineTitle(section.title), { pageNumber: section.page })
      for (const child of section.children) doc.outline.add(parent, outlineTitle(child.title), { pageNumber: child.page })
    }
    const pages = doc.getNumberOfPages()
    for (let index = 2; index <= pages; index++) {
      doc.setPage(index)
      setFont(doc, 6.5, 'bold', theme.strong)
      doc.text(clampLine(doc, options.shortName, 100, 6.5, 'bold'), margin, 12.4, { charSpace: 0.15 })
      if (options.tenant) {
        setFont(doc, 6.5, 'normal', PALETTE.muted)
        doc.text(clampLine(doc, options.tenant, 70, 6.5), right, 12.4, { align: 'right' })
      }
      drawRule(doc, margin, 14.6, right)
      drawRule(doc, margin, PAGE.height - 14.5, right)
      setFont(doc, 6.5, 'normal', PALETTE.muted)
      doc.text(clampLine(doc, footerLeft(), 100, 6.5), margin, PAGE.height - 10.6)
      doc.text(`Page ${index} of ${pages}`, right, PAGE.height - 10.6, { align: 'right' })
    }
    // A UTC date string, so the bytes do not depend on the time zone of the machine.
    const created = new Date(options.exportedAt)
    const year = created.getUTCFullYear()
    const stamp = (Number.isNaN(year) || year < 1970 || year > 2037 ? new Date(0) : created).toISOString().replace(/[-:T]/g, '').slice(0, 14)
    doc.setCreationDate(`D:${stamp}+00'00'`)
    doc.setFileId(fingerprint(options.identity))
    return new Uint8Array(doc.output('arraybuffer'))
  }

  return {
    doc, sanitize, theme, footerLeft,
    get y() { return y },
    set y(value: number) { y = value },
    page, addPage, ensure, wrap, measure, heightOf, drawLines, chunk, paragraph,
    pageTitle, heading, record, anchor, pageRef, link, flow, contentsPage, finish,
  }
}
