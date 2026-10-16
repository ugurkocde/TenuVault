import { PALETTE, TONES, capHeight, centredBaseline, chipWidth, clampLine, drawBrandMark, drawCard, drawChip, drawDonut, drawEyebrow, drawKpiTile, drawMarker, drawPill, drawRule, drawStackedBar, pillMetrics, setFont, textWidth, type BarSegment, type KpiTile, type MarkerKind, type PillOptions, type RgbColor, type Tone } from './kit'
import { luminance } from './theme'
import { PAGE, type FlowBlock, type Layout, type Line, type TextItem } from './layout'

/** Report building blocks composed from the kit and the layout engine. */

const { margin, right, contentWidth } = PAGE

export interface GlanceRow {
  label: string
  value: string
  marker: MarkerKind
  color: RgbColor
}

export interface CoverDonut {
  segments: BarSegment[]
  total: number
  value: string
  label?: string
}

export interface CoverSpec {
  eyebrow: string
  title: string
  subtitle?: string
  lead?: string
  tenant: string
  facts: [string, string][]
  /** Share drawn on the decorative ring of the band, 0 to 1. */
  ring: number
  donuts: CoverDonut[]
  donutCount?: string
  donutCaption: string
  donutSub: string
  glance: GlanceRow[]
  glanceNote?: string
  control: { label: string; value: string; span?: 1 | 2 }[]
  footerRight: string
}

/** Cover: brand band with the TenuVault mark, title and tenant, then the donut card, at a glance and document control. */
export function drawCover(layout: Layout, spec: CoverSpec) {
  const { doc, theme } = layout
  const band = 134
  doc.setFillColor(...theme.primary)
  doc.rect(0, 0, PAGE.width, band, 'F')
  doc.setDrawColor(...theme.ringSoft)
  doc.setLineWidth(0.6)
  doc.circle(173, 55, 70, 'S')
  doc.circle(173, 55, 38, 'S')
  drawDonut(doc, 173, 55, 56, 10, [{ value: Math.min(Math.max(spec.ring, 0), 1), color: theme.ringStrong }], 1, theme.ringSoft)

  // A white label report shows the customer logo or name; otherwise the TenuVault mark.
  if (theme.companyName) {
    if (!drawLogo(layout)) {
      setFont(doc, 11, 'bold', theme.onBand)
      doc.text(clampLine(doc, theme.companyName, 120, 11, 'bold'), margin, 19)
    }
  } else {
    drawBrandMark(doc, margin, 13.4, 7.4, theme.door, theme.primary)
    setFont(doc, 10, 'bold', theme.onBand)
    doc.text('TenuVault', margin + 10, 18.6)
  }

  doc.setFillColor(...theme.accent)
  doc.roundedRect(margin, 48.5, 14, 1.2, 0.6, 0.6, 'F')
  setFont(doc, 8.5, 'bold', theme.bandAccent)
  doc.text(clampLine(doc, spec.eyebrow, contentWidth, 8.5, 'bold'), margin, 56.5)
  let titleSize = 36
  while (titleSize > 24 && textWidth(doc, spec.title, titleSize, 'bold') > contentWidth) titleSize -= 1
  const titleLines = layout.wrap(spec.title, contentWidth, titleSize, 'bold', { maxLines: 2 })
  setFont(doc, titleSize, 'bold', theme.onBand)
  titleLines.forEach((line, index) => doc.text(line, margin, 70 + index * titleSize * 0.42))
  const titleBottom = 70 + (titleLines.length - 1) * titleSize * 0.42
  if (spec.subtitle) {
    let size = 13
    while (size > 8 && textWidth(doc, spec.subtitle, size) > contentWidth) size -= 0.5
    setFont(doc, size, 'normal', theme.bandMuted)
    doc.text(clampLine(doc, spec.subtitle, contentWidth, size), margin, titleBottom + 10)
  }
  if (spec.lead) {
    setFont(doc, 9, 'normal', theme.bandMuted)
    layout.wrap(spec.lead, 150, 9, 'normal', { maxLines: 2 }).forEach((line, index) => doc.text(line, margin, titleBottom + 16.5 + index * 4))
  }

  drawRule(doc, margin, 104, right, theme.bandRule, 0.25)
  drawEyebrow(doc, 'Tenant', margin, 110.5, { color: theme.bandAccent })
  let tenantSize = 18
  while (tenantSize > 11 && textWidth(doc, spec.tenant, tenantSize, 'bold') > 112) tenantSize -= 0.5
  setFont(doc, tenantSize, 'bold', theme.onBand)
  doc.text(clampLine(doc, spec.tenant, 112, tenantSize, 'bold'), margin, 118.5)
  spec.facts.forEach(([label, value], index) => {
    const baseline = 113.5 + index * 5
    setFont(doc, 8, 'bold', theme.onBand)
    const valueWidth = doc.getTextWidth(value)
    doc.text(value, right, baseline, { align: 'right' })
    setFont(doc, 8, 'normal', theme.bandMuted)
    doc.text(label, right - valueWidth - 1.6, baseline, { align: 'right' })
  })

  const midTop = 144
  drawCard(doc, margin, midTop, 72, 70, { fill: PALETTE.panel })
  const single = spec.donuts.length === 1
  spec.donuts.forEach((donut, index) => {
    const centerX = single ? margin + 36 : margin + 18 + index * 36
    const centerY = midTop + (single ? 28 : 26)
    const radius = single ? 18 : 12
    drawDonut(doc, centerX, centerY, radius, single ? 4.4 : 3.4, donut.segments, Math.max(donut.total, 1))
    let valueSize = single ? 24 : 14
    while (valueSize > 8 && textWidth(doc, donut.value, valueSize, 'bold') > radius * 1.5) valueSize -= 0.5
    setFont(doc, valueSize, 'bold', theme.strong)
    doc.text(donut.value, centerX, centerY + capHeight(valueSize) / 2 + (single ? -0.4 : 0), { align: 'center' })
    if (single && spec.donutCount) {
      setFont(doc, 6.6, 'normal', PALETTE.muted)
      doc.text(spec.donutCount, centerX, centerY + 6.6, { align: 'center' })
    }
    if (donut.label) {
      setFont(doc, 7.4, 'bold', PALETTE.ink)
      doc.text(donut.label, centerX, centerY + radius + 6, { align: 'center' })
    }
  })
  const captionLines = layout.wrap(spec.donutCaption, 64, 8.3, 'bold', { maxLines: 2 })
  const subLines = layout.wrap(spec.donutSub, 62, 7, 'normal', { maxLines: 2 })
  let captionY = midTop + 70 - 4 - subLines.length * 3 - captionLines.length * 3.7
  setFont(doc, 8.3, 'bold', PALETTE.ink)
  for (const line of captionLines) { captionY += 3.7; doc.text(line, margin + 36, captionY, { align: 'center' }) }
  captionY += 0.8
  setFont(doc, 7, 'normal', PALETTE.muted)
  for (const line of subLines) { captionY += 3; doc.text(line, margin + 36, captionY, { align: 'center' }) }

  const glanceX = margin + 80
  drawEyebrow(doc, 'At a glance', glanceX, midTop + 2.4, { color: theme.accentText })
  drawRule(doc, glanceX, midTop + 5, right, theme.strong, 0.4)
  const rowHeight = spec.glance.length > 5 ? 6.6 : spec.glance.length > 4 ? 7.6 : 9.6
  spec.glance.forEach((row, index) => {
    const rowTop = midTop + 5 + index * rowHeight
    const middle = rowTop + rowHeight / 2
    drawMarker(doc, glanceX + 1.4, middle, row.marker, row.color)
    setFont(doc, 11, 'bold', theme.strong)
    const valueWidth = doc.getTextWidth(row.value)
    doc.text(row.value, right, middle + capHeight(11) / 2, { align: 'right' })
    setFont(doc, 8.5, 'normal', PALETTE.ink)
    doc.text(clampLine(doc, row.label, right - glanceX - 8 - valueWidth, 8.5), glanceX + 5, middle + capHeight(8.5) / 2)
    drawRule(doc, glanceX, rowTop + rowHeight, right)
  })
  if (spec.glanceNote) {
    const noteTop = midTop + 5 + spec.glance.length * rowHeight + 4
    const maxLines = Math.max(1, Math.floor((midTop + 72 - noteTop) / 3.5))
    setFont(doc, 7.6, 'normal', PALETTE.muted)
    layout.wrap(spec.glanceNote, right - glanceX, 7.6, 'normal', { maxLines }).forEach((line, index) => doc.text(line, glanceX, noteTop + capHeight(7.6) + index * 3.5))
  }

  const gridTop = 222
  drawEyebrow(doc, 'Document control', margin, gridTop + 2.4, { color: theme.accentText })
  drawRule(doc, margin, gridTop + 5, right, theme.strong, 0.4)
  const cellWidth = contentWidth / 4
  const rows: { label: string; value: string; span: number }[][] = []
  const control = [...spec.control, { label: 'Prepared by', value: theme.preparedBy ?? '' }, { label: 'Classification', value: theme.classification ?? '' }]
  for (const cell of control.filter(item => item.value)) {
    const span = cell.span ?? 1
    const current = rows[rows.length - 1]
    const used = current?.reduce((sum, item) => sum + item.span, 0) ?? 4
    if (!current || used + span > 4) rows.push([{ ...cell, span }])
    else current.push({ ...cell, span })
  }
  let rowTop = gridTop + 5
  for (const cells of rows) {
    const lines = cells.map(cell => layout.wrap(cell.value, cellWidth * cell.span - 3, 8.2, 'bold', { technical: true, maxLines: 3 }))
    const height = Math.max(12, Math.max(...lines.map(item => item.length)) * 3.5 + 8.6)
    if (rowTop + height > PAGE.height - 14) break
    let cellX = margin
    cells.forEach((cell, index) => {
      setFont(doc, 6.3, 'bold', PALETTE.muted)
      doc.text(clampLine(doc, cell.label, cellWidth * cell.span - 3, 6.3, 'bold'), cellX, rowTop + 4.8)
      setFont(doc, 8.2, 'bold', PALETTE.ink)
      lines[index]!.forEach((line, lineIndex) => doc.text(line, cellX, rowTop + 7 + capHeight(8.2) + lineIndex * 3.5))
      cellX += cellWidth * cell.span
    })
    rowTop += height
    drawRule(doc, margin, rowTop, right)
  }
  setFont(doc, 6.5, 'normal', PALETTE.muted)
  doc.text(clampLine(doc, layout.footerLeft(), 100, 6.5), margin, 287)
  doc.text(spec.footerRight, right, 287, { align: 'right' })
}

/**
 * The customer logo top left of the cover, at most 44 by 14 mm. A PNG on a dark band sits on a white
 * rounded plate because it may be transparent. False when absent or unreadable.
 */
function drawLogo(layout: Layout): boolean {
  const { doc, theme } = layout
  if (!theme.logoDataUrl) return false
  try {
    const properties = doc.getImageProperties(theme.logoDataUrl)
    if (!properties.width || !properties.height) return false
    const scale = Math.min(44 / properties.width, 14 / properties.height)
    const width = properties.width * scale
    const height = properties.height * scale
    const jpeg = /^data:image\/jpe?g/i.test(theme.logoDataUrl)
    const plate = !jpeg && luminance(theme.primary) <= 0.5
    if (plate) {
      doc.setFillColor(...PALETTE.white)
      doc.roundedRect(margin - 2.5, 10, width + 5, height + 4, 1.5, 1.5, 'F')
    }
    doc.addImage(theme.logoDataUrl, jpeg ? 'JPEG' : 'PNG', margin, 12, width, height)
    return true
  } catch {
    return false
  }
}

/** A tinted panel with a round icon, a heading and body text; used above the contents and for notices. */
export function callout(layout: Layout, spec: { title: string; body: TextItem[]; tone: 'warn' | 'accent'; link?: { url: string; text: string } }, top?: number): number {
  const { doc, theme } = layout
  const colors = spec.tone === 'warn'
    ? { fill: [255, 250, 243] as RgbColor, stroke: [227, 194, 158] as RgbColor, icon: TONES.warn.text }
    : { fill: theme.accentWash, stroke: theme.accentBorder, icon: theme.accentText }
  const textX = margin + 14
  const width = contentWidth - 14 - 6
  const lines = layout.measure([{ text: spec.title, size: 8.8, style: 'bold', color: colors.icon, lineHeight: 4 }, ...spec.body.map(item => ({ size: 8.4, color: PALETTE.ink, lineHeight: 3.9, gap: 1.2, ...item }))], width)
  const chunks = layout.chunk(lines, 200)
  let used = 0
  chunks.forEach((part, index) => {
    const height = layout.heightOf(part) + 9
    if (top === undefined) layout.ensure(height)
    const cardTop = top ?? layout.y
    drawCard(doc, margin, cardTop, contentWidth, height, { fill: colors.fill, stroke: colors.stroke })
    if (index === 0) {
      doc.setFillColor(...colors.icon)
      doc.circle(margin + 7.5, cardTop + 7.3, 3, 'F')
      setFont(doc, 9, 'bold', PALETTE.white)
      doc.text('!', margin + 7.5, cardTop + 7.3 + capHeight(9) / 2, { align: 'center' })
    }
    layout.drawLines(part, textX, cardTop + 4.6)
    if (spec.link && index === chunks.length - 1) {
      const last = part.findIndex(line => line.text.includes(spec.link!.text))
      if (last >= 0) doc.link(textX, cardTop + 4.6 + part[last]!.offset - part[0]!.offset - 0.6, textWidth(doc, part[last]!.text, part[last]!.size, part[last]!.style), 4.2, { url: spec.link.url })
    }
    used += height
    if (top === undefined) layout.y += height + 5
  })
  return used
}

/** Hero card: a large figure with its label on the left, sentences and a progress bar on the right. */
export function hero(layout: Layout, spec: { value: string; label: string; lead: string; lines: string[]; bar?: { segments: BarSegment[]; total: number }; color?: RgbColor }) {
  const { doc } = layout
  const textX = margin + 58
  const textWidthMm = contentWidth - 58 - 6
  const lead = layout.measure([{ text: spec.lead, size: 9.4, style: 'bold', lineHeight: 4.3 }], textWidthMm)
  const body = layout.measure(spec.lines.map((text, index) => ({ text, size: 7.6, color: PALETTE.muted, lineHeight: 3.4, gap: index === 0 ? 1.4 : 0.6 })), textWidthMm)
  const textHeight = layout.heightOf(lead) + layout.heightOf(body) + (spec.bar ? 11 : 0)
  const height = Math.max(32, textHeight + 10)
  layout.ensure(height + 4)
  const top = layout.y
  drawCard(doc, margin, top, contentWidth, height, { fill: PALETTE.panel })
  let valueSize = 40
  while (valueSize > 18 && textWidth(doc, spec.value, valueSize, 'bold') > 50) valueSize -= 1
  setFont(doc, valueSize, 'bold', spec.color ?? layout.theme.strong)
  doc.text(spec.value, margin + 6, top + height / 2 + 4)
  layout.wrap(spec.label.toUpperCase(), 46, 5.8, 'bold', { maxLines: 3 }).forEach((line, index) =>
    drawEyebrow(doc, line, margin + 6.3, top + height / 2 + 9.5 + index * 2.8, { color: PALETTE.muted, size: 5.8, charSpace: 0.2 }))
  let textTop = top + (height - textHeight) / 2
  layout.drawLines(lead, textX, textTop)
  textTop += layout.heightOf(lead)
  if (body.length) layout.drawLines(body, textX, textTop + body[0]!.gap)
  textTop += layout.heightOf(body)
  if (spec.bar) {
    textTop += 3
    drawStackedBar(doc, textX, textTop, textWidthMm, 3, spec.bar.segments, Math.max(spec.bar.total, 1), { track: PALETTE.track })
    setFont(doc, 6.2, 'normal', PALETTE.muted)
    doc.text('0%', textX, textTop + 6.6)
    doc.text('50%', textX + textWidthMm / 2, textTop + 6.6, { align: 'center' })
    doc.text('100%', textX + textWidthMm, textTop + 6.6, { align: 'right' })
  }
  layout.y = top + height + 4
}

/** A row of KPI tiles across the content width. */
export function kpiRow(layout: Layout, tiles: KpiTile[]) {
  const gap = 4
  const width = (contentWidth - gap * (tiles.length - 1)) / tiles.length
  const height = 28
  layout.ensure(height + 5)
  tiles.forEach((tile, index) => drawKpiTile(layout.doc, margin + index * (width + gap), layout.y, width, height, tile))
  layout.y += height + 5
}

export interface LegendItem {
  label: string
  count: number
  marker: MarkerKind
  color: RgbColor
}

/** Section heading, a stacked bar of the items and a legend with marker, count, label and share. */
export function distribution(layout: Layout, spec: { title: string; note: string; items: LegendItem[]; total: number }) {
  const { doc } = layout
  layout.heading(spec.title, { note: spec.note, keep: 16 })
  drawStackedBar(doc, margin, layout.y, contentWidth, 4, spec.items.map(item => ({ value: item.count, color: item.color })), Math.max(spec.total, 1), { gap: 0.6 })
  let x = margin
  let y = layout.y + 7.4
  for (const item of spec.items.filter(entry => entry.count > 0)) {
    const share = spec.total > 0 ? `, ${Math.round((item.count / spec.total) * 100)}%` : ''
    const label = `${item.label}${share}`
    const countWidth = textWidth(doc, String(item.count), 7, 'bold')
    const width = 3.4 + countWidth + 1.2 + textWidth(doc, label, 7) + 6
    if (x + width > right + 6 && x > margin) { x = margin; y += 4.2 }
    drawMarker(doc, x + 1.1, y + 1.3, item.marker, item.color, 1)
    setFont(doc, 7, 'bold', PALETTE.ink)
    doc.text(String(item.count), x + 3.4, y + 2.3)
    setFont(doc, 7, 'normal', PALETTE.muted)
    doc.text(label, x + 3.4 + countWidth + 1.2, y + 2.3)
    x += width
  }
  layout.y = y + 4.2 + 4
}

/** A note card: an eyebrow in the left column and paragraphs on the right. */
export function noteCard(layout: Layout, label: string, paragraphs: string[]) {
  const { doc } = layout
  const lines = layout.measure(paragraphs.map((text, index) => ({ text, size: 7.6, color: PALETTE.body, lineHeight: 3.5, gap: index ? 1.6 : 0 })), contentWidth - 50)
  for (const [index, part] of layout.chunk(lines).entries()) {
    const height = layout.heightOf(part) - (part[0]?.gap ?? 0) + 10
    layout.ensure(height)
    drawCard(doc, margin, layout.y, contentWidth, height, { fill: PALETTE.panel })
    if (index === 0) drawEyebrow(doc, label, margin + 6, layout.y + 5 + capHeight(6.5), { size: 6.2, charSpace: 0.25, color: layout.theme.accentText })
    layout.drawLines(part, margin + 44, layout.y + 5)
    layout.y += height + 5
  }
}

export interface Fact {
  label: string
  value: string
  technical?: boolean
  /** Takes the full width instead of a column. */
  wide?: boolean
}

/** Label and value pairs in two columns, with long values across the full width. */
export function facts(layout: Layout, items: Fact[], caption: string) {
  const { doc } = layout
  const columnWidth = (contentWidth - 8) / 2
  const rows: Fact[][] = []
  for (const item of items) {
    const current = rows[rows.length - 1]
    if (item.wide || !current || current.length === 2 || current[0]!.wide) rows.push([item])
    else current.push(item)
  }
  const blocks: FlowBlock[] = []
  for (const row of rows) {
    const width = row[0]!.wide ? contentWidth : columnWidth
    const cells = row.map(item => layout.measure([{ text: item.value, size: 8.4, style: 'bold', technical: item.technical, lineHeight: 3.7 }], width - 2))
    const parts = cells.map(lines => layout.chunk(lines))
    const count = Math.max(...parts.map(part => part.length))
    for (let index = 0; index < count; index++) {
      const height = Math.max(...parts.map(part => layout.heightOf(part[index] ?? []))) + (index === 0 ? 6.4 : 1.6) + 2.4
      blocks.push({
        height,
        draw: top => {
          row.forEach((item, column) => {
            const x = margin + column * (columnWidth + 8)
            if (index === 0) {
              setFont(doc, 6.4, 'bold', PALETTE.muted)
              doc.text(clampLine(doc, item.label, width, 6.4, 'bold'), x, top + 4.2)
            }
            layout.drawLines(parts[column]![index] ?? [], x, top + (index === 0 ? 6.4 : 1.6))
          })
          if (index === count - 1) drawRule(doc, margin, top + height, right)
        },
      })
    }
  }
  layout.flow(blocks, { caption })
  layout.y += 4
}

/** Bulleted text in the flow; long items continue on the next page. */
export function bullets(layout: Layout, items: string[], caption: string, options: { color?: RgbColor; size?: number } = {}) {
  const { doc } = layout
  const size = options.size ?? 8
  const blocks: FlowBlock[] = []
  for (const item of items) {
    const parts = layout.chunk(layout.measure([{ text: item, size, color: PALETTE.body, lineHeight: size * 0.46 }], contentWidth - 6))
    parts.forEach((part, index) => {
      const height = layout.heightOf(part) + (index === parts.length - 1 ? 1.8 : 0)
      blocks.push({
        height,
        draw: top => {
          if (index === 0) {
            doc.setFillColor(...(options.color ?? layout.theme.accent))
            doc.circle(margin + 1.2, top + capHeight(size) / 2 + 0.1, 0.6, 'F')
          }
          layout.drawLines(part, margin + 5, top)
        },
      })
    })
  }
  layout.flow(blocks, { caption })
  layout.y += 2
}

/** A bordered panel with a marker, a title and items separated by rules; continues across pages. */
export function panel(layout: Layout, spec: { title: string; items: string[]; marker: MarkerKind; color: RgbColor; dashed?: boolean; caption: string }) {
  const { doc } = layout
  const innerX = margin + 4
  const innerWidth = contentWidth - 8
  const head = layout.measure([{ text: spec.title, size: 8.2, style: 'bold', color: PALETTE.ink, lineHeight: 3.8 }], innerWidth - 6)
  const blocks: FlowBlock[] = [{
    height: layout.heightOf(head) + 4.6,
    draw: top => {
      drawMarker(doc, innerX + 1.2, top + 4 + 1.5, spec.marker, spec.color)
      layout.drawLines(head, innerX + 4.5, top + 4)
    },
  }]
  spec.items.forEach((item, itemIndex) => {
    const parts = layout.chunk(layout.measure([{ text: item, size: 7.6, color: PALETTE.body, lineHeight: 3.4 }], innerWidth - 2))
    parts.forEach((part, index) => {
      const last = index === parts.length - 1
      const height = layout.heightOf(part) + (last ? 3 : 0.6)
      blocks.push({
        height,
        draw: top => {
          layout.drawLines(part, innerX, top + 1.2)
          if (last && itemIndex < spec.items.length - 1) drawRule(doc, innerX, top + height - 0.4, right - 4)
        },
      })
    })
  })
  if (blocks[1]) blocks[0]!.keep = Math.min(blocks[1].height, 40)
  layout.flow(blocks, { caption: spec.caption, card: { dashed: spec.dashed } })
  layout.y += 4
}

export interface Column {
  header: string
  width: number
  align?: 'left' | 'right'
}

export type Cell =
  | { text: TextItem[]; chip?: string }
  | { pill: string; options: PillOptions }
  | { bar: BarSegment[]; total: number; label: string }
  | { page: string }
  | undefined

export interface Row {
  cells: Cell[]
  /** Background of a row that needs attention; replaces the zebra fill. */
  wash?: RgbColor
  /** The row opens the page recorded for this key. */
  link?: string
  /** Full width lines below the cells: a small label and its text. */
  details?: { label: string; items: TextItem[] }[]
}

export interface Group {
  label: string
  note?: string
  marker?: { kind: MarkerKind; color: RgbColor }
  rows: Row[]
}

export interface TableSpec {
  columns: Column[]
  groups: Group[]
  x?: number
  width?: number
  valign?: 'top' | 'middle'
  zebra?: boolean
  minRow?: number
}

/** The header block and row blocks of a table; `rowStart` is the index of the first row block. */
export function tableBlocks(layout: Layout, spec: TableSpec): { header: FlowBlock; blocks: FlowBlock[] } {
  const { doc, theme } = layout
  const x = spec.x ?? margin
  const width = spec.width ?? contentWidth
  const tableRight = x + width
  const columnX = spec.columns.map((_, index) => x + spec.columns.slice(0, index).reduce((sum, column) => sum + column.width, 0))
  const padY = 1.9
  const blocks: FlowBlock[] = []
  const header: FlowBlock = {
    height: 6.4,
    draw: top => {
      spec.columns.forEach((column, index) => {
        const alignRight = column.align === 'right'
        drawEyebrow(doc, column.header, alignRight ? columnX[index]! + column.width - 1.5 : columnX[index]! + 1.5, top + 3.4, { color: PALETTE.muted, size: 5.6, charSpace: 0.2, align: alignRight ? 'right' : 'left' })
      })
      drawRule(doc, x, top + 5.2, tableRight, theme.strong, 0.4)
    },
  }
  let zebra = 0
  for (const group of spec.groups) {
    const first = blocks.length
    if (group.label) {
      blocks.push({
        height: 7,
        draw: top => {
          doc.setFillColor(...theme.primaryTint)
          doc.rect(x, top, width, 7, 'F')
          let labelX = x + 1.5
          if (group.marker) { drawMarker(doc, labelX + 1.1, top + 3.5, group.marker.kind, group.marker.color, 1.1, theme.primaryTint); labelX += 4 }
          setFont(doc, 7.4, 'bold', theme.strong)
          doc.text(clampLine(doc, group.label, width - 50, 7.4, 'bold'), labelX, centredBaseline(top, 7, 7.4))
          if (group.note) {
            setFont(doc, 6.8, 'normal', PALETTE.muted)
            doc.text(group.note, tableRight - 1.5, centredBaseline(top, 7, 6.8), { align: 'right' })
          }
        },
      })
    }
    zebra = 0
    for (const row of group.rows) {
      const fill = row.wash ?? (spec.zebra !== false && zebra++ % 2 === 1 ? PALETTE.zebra : undefined)
      const measured = row.cells.map((cell, index) => {
        const column = spec.columns[index]!
        if (cell && 'text' in cell) {
          const chip = cell.chip ? Math.max(chipWidth(doc, cell.chip, 6.6), 9.6) : 0
          // An identifier too long for a chip becomes the first line of the cell instead.
          if (chip > (column.width - 3) / 2) return { chip: 0, lines: layout.measure([{ text: cell.chip!, size: 7.2, style: 'bold', color: theme.strong, technical: true }, ...cell.text], column.width - 3) }
          return { chip, lines: layout.measure(cell.text, column.width - 3 - (chip ? chip + 2.2 : 0)) }
        }
        return { chip: 0, lines: [] as Line[] }
      })
      const parts = measured.map(item => layout.chunk(item.lines))
      const chunkCount = Math.max(1, ...parts.map(part => part.length))
      const fixedHeight = Math.max(0, ...row.cells.map(cell => cell && 'pill' in cell ? 4.4 : cell && ('bar' in cell || 'page' in cell) ? 3.4 : 0), ...measured.map(item => item.chip ? 4.4 : 0))
      const rowBlocks: FlowBlock[] = []
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const contentHeight = Math.max(chunkIndex === 0 ? fixedHeight : 0, ...parts.map(part => layout.heightOf(part[chunkIndex] ?? [])))
        const height = Math.max(chunkIndex === 0 ? spec.minRow ?? 7 : 0, contentHeight + padY * 2)
        rowBlocks.push({
          height,
          draw: top => {
            if (fill) { doc.setFillColor(...fill); doc.rect(x, top, width, height, 'F') }
            const middle = spec.valign === 'middle' && chunkCount === 1
            row.cells.forEach((cell, index) => {
              const column = spec.columns[index]!
              const cellX = columnX[index]! + 1.5
              const cellWidth = column.width - 3
              const lines = parts[index]?.[chunkIndex] ?? []
              if (!cell) return
              if ('text' in cell) {
                const own = layout.heightOf(lines)
                const cellTop = middle ? top + (height - Math.max(own, measured[index]!.chip ? 4.4 : 0)) / 2 : top + padY
                let textX = cellX
                if (measured[index]!.chip) {
                  if (chunkIndex === 0) drawChip(doc, cellX, middle ? top + height / 2 - 2.2 : cellTop - 0.4, cell.chip!, { size: 6.6, minWidth: 9.6, fill: theme.primaryTint, color: theme.strong })
                  textX += measured[index]!.chip + 2.2
                }
                if (lines.length) layout.drawLines(lines, column.align === 'right' ? cellX + cellWidth : textX, middle ? top + (height - own) / 2 : top + padY, column.align === 'right' ? 'right' : 'left')
                return
              }
              if (chunkIndex > 0) return
              const anchorTop = middle ? top + height / 2 : top + padY + 1.8
              if ('pill' in cell) {
                const options = { ...cell.options, small: true, maxWidth: cellWidth + 1 }
                const pillWidth = pillMetrics(doc, cell.pill, options).width
                drawPill(doc, column.align === 'right' ? cellX + cellWidth - pillWidth : cellX - 0.5, anchorTop - 2.1, cell.pill, options)
              } else if ('bar' in cell) {
                drawStackedBar(doc, cellX, anchorTop - 0.8, 12, 1.6, cell.bar, Math.max(cell.total, 1), { gap: 0.3 })
                setFont(doc, 7.2, 'normal', PALETTE.ink)
                doc.text(clampLine(doc, cell.label, cellWidth - 14, 7.2), cellX + 14, anchorTop + capHeight(7.2) / 2)
              } else {
                layout.pageRef(cell.page, cellX + cellWidth, anchorTop + capHeight(7.4) / 2)
              }
            })
            if (row.link) layout.link(row.link, x, top, width, height)
          },
        })
      }
      for (const detail of row.details ?? []) {
        const label = layout.measure([{ text: detail.label.toUpperCase(), size: 5.6, style: 'bold', color: PALETTE.muted, lineHeight: 2.8 }], 22)
        const lines = layout.measure(detail.items, width - 30)
        layout.chunk(lines).forEach((part, index) => {
          const height = Math.max(layout.heightOf(part), index === 0 ? layout.heightOf(label) : 0) + 2
          rowBlocks.push({
            height,
            draw: top => {
              if (fill) { doc.setFillColor(...fill); doc.rect(x, top, width, height, 'F') }
              if (index === 0) {
                setFont(doc, 5.6, 'bold', PALETTE.muted)
                label.forEach((line, lineIndex) => doc.text(line.text, x + 1.5, top + 0.6 + capHeight(7) + lineIndex * 2.8, { charSpace: 0.2 }))
              }
              layout.drawLines(part, x + 26, top + 0.6)
            },
          })
        })
      }
      // The rule under the row, after its last block.
      const last = rowBlocks[rowBlocks.length - 1]!
      const drawLast = last.draw
      last.draw = top => { drawLast(top); drawRule(doc, x, top + last.height, tableRight) }
      // Keep a row with its details when they are short enough to move together.
      rowBlocks.forEach((block, index) => { block.keep = Math.min(rowBlocks.slice(index + 1).reduce((sum, next) => sum + next.height, 0), 60) })
      blocks.push(...rowBlocks)
    }
    if (group.label && blocks[first + 1]) blocks[first]!.keep = blocks[first + 1]!.height + (blocks[first + 1]!.keep ?? 0)
  }
  header.keep = blocks[0] ? blocks[0].height + (blocks[0].keep ?? 0) : 0
  return { header, blocks }
}

/** A table in the flow; the header repeats on every page it continues on. */
export function table(layout: Layout, spec: TableSpec, caption: string) {
  const { header, blocks } = tableBlocks(layout, spec)
  layout.flow([header, ...blocks], { caption, repeat: index => index > 0 ? header : undefined })
  layout.y += 4
}

export interface SectionColumn {
  header: string
  /** Width in mm; columns without one share the remaining width. */
  width?: number
  align?: 'left' | 'right'
}

export interface StatusCell {
  label: string
  tone: Tone
  marker: MarkerKind
  color?: RgbColor
}

/**
 * A heading and a table from plain columns and rows, for reports that only have text cells.
 * Strings become wrapped text; `status` adds a right aligned pill column.
 */
export function tableSection(layout: Layout, spec: { title: string; note?: string; toc?: boolean; columns: SectionColumn[]; rows: (string | Cell)[][]; status?: { header: string; width?: number; cell: (index: number) => StatusCell }; caption?: string }) {
  const columns = [...spec.columns, ...(spec.status ? [{ header: spec.status.header, width: spec.status.width ?? 34, align: 'right' as const }] : [])]
  const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0)
  const flexible = columns.filter(column => column.width === undefined).length
  const resolved: Column[] = columns.map(column => ({ header: column.header, width: column.width ?? (contentWidth - fixed) / Math.max(flexible, 1), align: column.align }))
  const rows: Row[] = spec.rows.map((row, index) => {
    const status = spec.status?.cell(index)
    return {
      cells: [
        ...row.map(cell => typeof cell === 'string' ? { text: [{ text: cell, size: 7.4, color: PALETTE.ink }] } : cell),
        ...(status ? [{ pill: status.label, options: { tone: status.tone, marker: status.marker, markerColor: status.color } }] : []),
      ],
    }
  })
  layout.heading(spec.title, { note: spec.note, toc: spec.toc })
  table(layout, { columns: resolved, groups: [{ label: '', rows }] }, spec.caption ?? spec.title)
}
