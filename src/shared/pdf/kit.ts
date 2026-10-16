import type { jsPDF } from 'jspdf'

// Adapted from the Intune Documentation compliance report kit, in the TenuVault palette.
// Geometry is in millimetres, type in points. Only built-in Helvetica, solid fills, lines,
// circles and rounded rectangles are used so every viewer renders the same.

export type RgbColor = [number, number, number]
export type FontStyle = 'normal' | 'bold' | 'italic'
export type MarkerKind = 'filled' | 'half' | 'outline' | 'triangle' | 'dash'

/** Math.sin and Math.cos may differ in the last bit between CPUs; rounding keeps PDF bytes identical. */
export function fixedPoint(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** Neutral colours. Brand colours come from the resolved theme (theme.ts), status colours from presentation.ts. */
export const PALETTE = {
  ink: [43, 41, 39],
  body: [69, 66, 62],
  muted: [118, 113, 107],
  faint: [163, 158, 152],
  rule: [228, 225, 221],
  border: [218, 214, 209],
  panel: [244, 243, 241],
  zebra: [249, 248, 247],
  tint: [238, 236, 233],
  track: [228, 225, 221],
  dashed: [210, 206, 201],
  white: [255, 255, 255],
} as const satisfies Record<string, RgbColor>

/** The coral of the TenuVault mark; product attribution, never rebranded. */
const MARK_CORAL: RgbColor = [228, 103, 75]

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info' | 'conflict'

/** Text and background pairs for pills; markers use the semantic status colours. */
export const TONES: Record<Tone, { text: RgbColor; fill: RgbColor }> = {
  good: { text: [24, 104, 64], fill: [231, 242, 236] },
  warn: { text: [143, 79, 16], fill: [250, 239, 227] },
  bad: { text: [173, 62, 38], fill: [252, 236, 231] },
  neutral: { text: [71, 85, 105], fill: [238, 240, 243] },
  info: { text: [22, 21, 20], fill: [238, 236, 233] },
  conflict: { text: [185, 28, 28], fill: [251, 233, 233] },
}

const POINT_TO_MM = 0.3528

/** Normalises dashes, curly quotes and ellipses to the WinAnsi characters Helvetica draws. */
export function ascii(value: string): string {
  return value.replace(/[‐-―]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
}

/** A colour between two colours, for tints on the charcoal cover. */
export function mixColor(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  return from.map((value, index) => Math.round(value + (to[index]! - value) * amount)) as RgbColor
}

/** Approximate cap height in mm for Helvetica at the given point size. */
export function capHeight(size: number): number {
  return size * POINT_TO_MM * 0.7
}

/** Baseline that vertically centres a single line in a box. */
export function centredBaseline(top: number, height: number, size: number): number {
  return top + height / 2 + capHeight(size) / 2
}

export function setFont(doc: jsPDF, size: number, style: FontStyle = 'normal', color?: RgbColor) {
  doc.setFont('helvetica', style)
  doc.setFontSize(size)
  if (color) doc.setTextColor(...color)
}

export function textWidth(doc: jsPDF, text: string, size: number, style: FontStyle = 'normal', charSpace = 0): number {
  setFont(doc, size, style)
  return doc.getTextWidth(text) + charSpace * Math.max(text.length - 1, 0)
}

/** Shortens a single line with an ellipsis until it fits the width. Only for labels, never for evidence. */
export function clampLine(doc: jsPDF, text: string, width: number, size: number, style: FontStyle = 'normal'): string {
  if (textWidth(doc, text, size, style) <= width) return text
  let low = 1
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textWidth(doc, `${text.slice(0, middle)}...`, size, style) <= width) low = middle
    else high = middle - 1
  }
  return `${text.slice(0, low).trimEnd()}...`
}

// Placeholder that marks a break opportunity inside a technical identifier; removed after wrapping.
const BREAK = '\u0001'

/** Splits a line that is still too wide into pieces that fit, character by character. */
function hardBreak(doc: jsPDF, line: string, width: number, size: number, style: FontStyle): string[] {
  const pieces: string[] = []
  let rest = line
  while (rest && textWidth(doc, rest, size, style) > width) {
    let cut = 1
    while (cut < rest.length && textWidth(doc, rest.slice(0, cut + 1), size, style) <= width) cut++
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) pieces.push(rest)
  return pieces
}

/**
 * Wraps text to the width. Technical text (ids, URLs, JSON) also breaks after _ . / , ; : = & ?
 * and, as a last resort, between characters, so nothing runs past its column. With maxLines the
 * last kept line ends in an ellipsis; leave it unlimited for evidence that must stay complete.
 */
export function wrapLines(doc: jsPDF, text: string, width: number, size: number, style: FontStyle = 'normal', options: { technical?: boolean; maxLines?: number } = {}): string[] {
  setFont(doc, size, style)
  const source = options.technical ? text.replace(/([_./,;:=&?\\-])(?=\S)/g, `$1${BREAK} `) : text
  const lines = (doc.splitTextToSize(source, Math.max(width, 1)) as string[])
    .map(line => options.technical ? line.replace(new RegExp(`${BREAK} ?`, 'g'), '') : line)
    .flatMap(line => hardBreak(doc, line, width, size, style))
  const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY
  if (lines.length <= maxLines) return lines.length ? lines : ['']
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = clampLine(doc, `${kept[maxLines - 1] ?? ''} ${lines[maxLines] ?? ''}`, width, size, style)
  if (!kept[maxLines - 1]!.endsWith('...')) kept[maxLines - 1] = clampLine(doc, `${kept[maxLines - 1]}...`, width, size, style)
  return kept
}

/** Uppercase label with letter spacing. Never use it for text a reader searches for. */
export function drawEyebrow(doc: jsPDF, text: string, x: number, y: number, options: { color?: RgbColor; size?: number; charSpace?: number; align?: 'left' | 'right' } = {}): number {
  const size = options.size ?? 6.5
  const charSpace = options.charSpace ?? 0.25
  const label = text.toUpperCase()
  const width = textWidth(doc, label, size, 'bold', charSpace)
  setFont(doc, size, 'bold', options.color ?? PALETTE.muted)
  doc.text(label, options.align === 'right' ? x - width : x, y, { charSpace })
  return width
}

function fillPolygon(doc: jsPDF, points: ReadonlyArray<[number, number]>) {
  const first = points[0]
  if (!first) return
  const segments: Array<[number, number]> = []
  for (let index = 1; index < points.length; index++) {
    segments.push([fixedPoint(points[index]![0] - points[index - 1]![0]), fixedPoint(points[index]![1] - points[index - 1]![1])])
  }
  doc.lines(segments, first[0], first[1], [1, 1], 'F', true)
}

/** Status marker. The shape carries the status together with its label, never the colour alone. */
export function drawMarker(doc: jsPDF, centerX: number, centerY: number, kind: MarkerKind, color: RgbColor, radius = 1.1, background: RgbColor = PALETTE.white) {
  doc.setLineWidth(0.35)
  doc.setDrawColor(...color)
  doc.setFillColor(...color)
  if (kind === 'filled') {
    doc.circle(centerX, centerY, radius, 'F')
  } else if (kind === 'half') {
    doc.setFillColor(...background)
    doc.circle(centerX, centerY, radius, 'F')
    doc.setFillColor(...color)
    const points: Array<[number, number]> = []
    for (let step = 0; step <= 12; step++) {
      const angle = Math.PI / 2 + (Math.PI * step) / 12
      points.push([fixedPoint(centerX + radius * Math.cos(angle)), fixedPoint(centerY - radius * Math.sin(angle))])
    }
    fillPolygon(doc, points)
    doc.circle(centerX, centerY, radius, 'S')
  } else if (kind === 'outline') {
    doc.setFillColor(...background)
    doc.circle(centerX, centerY, radius, 'FD')
  } else if (kind === 'dash') {
    doc.roundedRect(centerX - radius, centerY - radius * 0.32, radius * 2, radius * 0.64, radius * 0.3, radius * 0.3, 'F')
  } else {
    const r = radius * 1.15
    doc.triangle(centerX - r, centerY + r * 0.85, centerX + r, centerY + r * 0.85, centerX, centerY - r * 1.05, 'F')
  }
}

export interface PillOptions {
  tone: Tone
  marker?: MarkerKind
  markerColor?: RgbColor
  small?: boolean
  /** Shrinks the label font so the pill never exceeds this width. */
  maxWidth?: number
}

export function pillMetrics(doc: jsPDF, label: string, options: PillOptions): { width: number; height: number; size: number } {
  let size = options.small ? 6.2 : 6.6
  const height = options.small ? 4.2 : 4.8
  const padLeft = options.marker ? (options.small ? 1.6 : 1.8) : 2.2
  const markerSpace = options.marker ? 3.5 : 0
  const measure = () => padLeft + markerSpace + textWidth(doc, label, size, 'bold') + 2.2
  if (options.maxWidth !== undefined) while (size > 4.6 && measure() > options.maxWidth) size -= 0.2
  return { width: measure(), height, size }
}

/** Fully rounded status pill with a marker. Returns its width. */
export function drawPill(doc: jsPDF, x: number, top: number, label: string, options: PillOptions): number {
  const tone = TONES[options.tone]
  const { width, height, size } = pillMetrics(doc, label, options)
  doc.setFillColor(...tone.fill)
  doc.roundedRect(x, top, width, height, height / 2, height / 2, 'F')
  let textX = x + 2.2
  if (options.marker) {
    const padLeft = options.small ? 1.6 : 1.8
    drawMarker(doc, x + padLeft + 1.1, top + height / 2, options.marker, options.markerColor ?? tone.text, options.small ? 1 : 1.1, tone.fill)
    textX = x + padLeft + 3.5
  }
  setFont(doc, size, 'bold', tone.text)
  doc.text(label, textX, centredBaseline(top, height, size))
  return width
}

export function chipWidth(doc: jsPDF, label: string, size = 6.8): number {
  return textWidth(doc, label, size, 'bold') + 3.2
}

/** Small rectangular chip for identifiers. */
export function drawChip(doc: jsPDF, x: number, top: number, label: string, options: { size?: number; height?: number; minWidth?: number; fill?: RgbColor; color?: RgbColor } = {}): number {
  const size = options.size ?? 6.8
  const height = options.height ?? 4.4
  const width = Math.max(chipWidth(doc, label, size), options.minWidth ?? 0)
  doc.setFillColor(...(options.fill ?? PALETTE.tint))
  doc.roundedRect(x, top, width, height, 1, 1, 'F')
  setFont(doc, size, 'bold', options.color ?? PALETTE.ink)
  doc.text(label, x + width / 2, centredBaseline(top, height, size), { align: 'center' })
  return width
}

export interface BarSegment {
  value: number
  color: RgbColor
}

/** Horizontal stacked bar with rounded ends on the track. */
export function drawStackedBar(doc: jsPDF, x: number, top: number, width: number, height: number, segments: readonly BarSegment[], total: number, options: { track?: RgbColor; gap?: number } = {}) {
  const radius = height / 2
  doc.setFillColor(...(options.track ?? PALETTE.track))
  doc.roundedRect(x, top, width, height, radius, radius, 'F')
  if (total <= 0) return
  const visible = segments.filter(segment => segment.value > 0)
  const gap = options.gap ?? 0
  const usable = width - gap * Math.max(visible.length - 1, 0)
  let cursor = x
  visible.forEach((segment, index) => {
    const segmentWidth = (usable * segment.value) / total
    if (segmentWidth <= 0) return
    doc.setFillColor(...segment.color)
    const isFirst = index === 0
    const isLast = index === visible.length - 1 && Math.abs(cursor + segmentWidth - (x + width)) < 0.01
    if (segmentWidth >= height && (isFirst || isLast)) {
      doc.roundedRect(cursor, top, segmentWidth, height, radius, radius, 'F')
      // Square the inner edge so adjoining segments meet cleanly.
      if (isFirst && !isLast) doc.rect(cursor + segmentWidth - radius, top, radius, height, 'F')
      if (isLast && !isFirst) doc.rect(cursor, top, radius, height, 'F')
    } else {
      doc.rect(cursor, top, segmentWidth, height, 'F')
    }
    cursor += segmentWidth + gap
  })
}

/** Ring chart: a full track ring with arcs for each segment, clockwise from 12 o'clock. */
export function drawDonut(doc: jsPDF, centerX: number, centerY: number, radius: number, thickness: number, segments: readonly BarSegment[], total: number, track: RgbColor = PALETTE.track) {
  doc.setLineWidth(thickness)
  doc.setDrawColor(...track)
  doc.circle(centerX, centerY, radius, 'S')
  if (total <= 0) return
  let start = 0
  for (const segment of segments) {
    const fraction = Math.min(Math.max(segment.value / total, 0), 1 - start)
    if (fraction <= 0) continue
    if (fraction >= 0.999) {
      doc.setDrawColor(...segment.color)
      doc.circle(centerX, centerY, radius, 'S')
      return
    }
    const steps = Math.max(Math.ceil(fraction * 120), 2)
    const points: Array<[number, number]> = []
    for (let step = 0; step <= steps; step++) {
      const angle = -Math.PI / 2 + 2 * Math.PI * (start + fraction * (step / steps))
      points.push([fixedPoint(centerX + radius * Math.cos(angle)), fixedPoint(centerY + radius * Math.sin(angle))])
    }
    const lines: Array<[number, number]> = []
    for (let index = 1; index < points.length; index++) {
      lines.push([fixedPoint(points[index]![0] - points[index - 1]![0]), fixedPoint(points[index]![1] - points[index - 1]![1])])
    }
    doc.setDrawColor(...segment.color)
    doc.setLineCap('butt')
    doc.setLineJoin('round')
    doc.lines(lines, points[0]![0], points[0]![1], [1, 1], 'S', false)
    doc.setLineJoin('miter')
    start += fraction
  }
}

export interface CardOptions {
  fill?: RgbColor
  stroke?: RgbColor
  radius?: number
  lineWidth?: number
  dashed?: boolean
}

export function drawCard(doc: jsPDF, x: number, top: number, width: number, height: number, options: CardOptions = {}) {
  const radius = options.radius ?? 2
  const { fill, stroke } = options
  if (fill) doc.setFillColor(...fill)
  if (stroke) {
    doc.setDrawColor(...stroke)
    doc.setLineWidth(options.lineWidth ?? 0.25)
  }
  if (options.dashed) doc.setLineDashPattern([1.2, 0.9], 0)
  doc.roundedRect(x, top, width, height, radius, radius, fill && stroke ? 'FD' : fill ? 'F' : 'S')
  if (options.dashed) doc.setLineDashPattern([], 0)
}

export function drawRule(doc: jsPDF, x1: number, y: number, x2: number, color: RgbColor = PALETTE.rule, lineWidth = 0.2) {
  doc.setDrawColor(...color)
  doc.setLineWidth(lineWidth)
  doc.line(x1, y, x2, y)
}

export interface KpiTile {
  label: string
  value: string
  caption: string
  marker: MarkerKind
  markerColor: RgbColor
  valueColor: RgbColor
}

/** KPI tile: eyebrow with marker, large number and a caption. */
export function drawKpiTile(doc: jsPDF, x: number, top: number, width: number, height: number, tile: KpiTile) {
  drawCard(doc, x, top, width, height, { stroke: PALETTE.border })
  drawMarker(doc, x + 5.1, top + 5.6, tile.marker, tile.markerColor, 1.1)
  const label = tile.label.toUpperCase()
  const labelWidth = width - 10.5
  let labelSize = 6.2
  while (labelSize > 5.4 && textWidth(doc, label, labelSize, 'bold', 0.15) > labelWidth) labelSize -= 0.2
  const labelLines = textWidth(doc, label, labelSize, 'bold', 0.15) > labelWidth ? wrapLines(doc, label, labelWidth - label.length * 0.08, labelSize, 'bold', { maxLines: 2 }) : [label]
  setFont(doc, labelSize, 'bold', PALETTE.muted)
  labelLines.forEach((line, index) => doc.text(line, x + 7.4, top + 6.5 + index * 2.6, { charSpace: 0.15 }))
  let valueSize = 22
  while (valueSize > 11 && textWidth(doc, tile.value, valueSize, 'bold') > width - 8) valueSize -= 1
  setFont(doc, valueSize, 'bold', tile.valueColor)
  doc.text(tile.value, x + 4, top + 16.5 + (labelLines.length - 1) * 1.2)
  const captionLines = wrapLines(doc, tile.caption, width - 8, 6.8, 'normal', { maxLines: 2 })
  setFont(doc, 6.8, 'normal', PALETTE.muted)
  captionLines.forEach((line, index) => doc.text(line, x + 4, top + 21.4 + index * 2.9))
}

function rotate(x: number, y: number, degrees: number): [number, number] {
  const angle = (degrees * Math.PI) / 180
  const dx = x - 512
  const dy = y - 512
  return [512 + dx * Math.cos(angle) - dy * Math.sin(angle), 512 + dx * Math.sin(angle) + dy * Math.cos(angle)]
}

/**
 * The TenuVault mark from BrandMark.tsx (1024 unit space, view box 178 to 846): a vault door ring with
 * two hinges and a coral three spoke wheel handle. Drawn with vectors at the given size.
 */
export function drawBrandMark(doc: jsPDF, x: number, top: number, size: number, door: RgbColor, background: RgbColor) {
  const scale = size / 668
  const px = (u: number) => fixedPoint(x + (u - 178) * scale)
  const py = (v: number) => fixedPoint(top + (v - 178) * scale)
  doc.setLineCap('butt')
  doc.setDrawColor(...door)
  doc.setLineWidth(62 * scale)
  doc.circle(px(512), py(512), 269 * scale, 'S')
  doc.setDrawColor(...mixColor(background, door, 0.14))
  doc.setLineWidth(16 * scale)
  doc.circle(px(512), py(512), 204 * scale, 'S')
  doc.setFillColor(...door)
  for (const hingeY of [392, 562]) doc.roundedRect(px(178), py(hingeY), 70 * scale, 70 * scale, 18 * scale, 18 * scale, 'F')
  doc.setFillColor(...MARK_CORAL)
  for (const angle of [0, 120, 240]) {
    const corners = [[490, 362], [534, 362], [534, 452], [490, 452]].map(([u, v]) => rotate(u!, v!, angle))
    fillPolygon(doc, corners.map(([u, v]) => [px(u), py(v)]))
    const [cu, cv] = rotate(512, 362, angle)
    doc.circle(px(cu), py(cv), 36 * scale, 'F')
  }
  doc.setDrawColor(...MARK_CORAL)
  doc.setLineWidth(52 * scale)
  doc.circle(px(512), py(512), 52 * scale, 'S')
}

/** A 32 hex digit fingerprint of the text, for a file id that is stable for the same input. */
export function fingerprint(text: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
  return seeds.map(seed => {
    let hash = seed >>> 0
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }).join('').toUpperCase()
}
