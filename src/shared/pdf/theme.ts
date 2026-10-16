import { PALETTE, TONES, mixColor, type RgbColor } from './kit'

/**
 * Customer branding of a report. Branding is a full white label and applies only when companyName
 * is set; without it the whole object is ignored. Invalid values fall back to TenuVault.
 */
export interface PdfBranding {
  companyName?: string
  /** A PNG or JPEG data URL. */
  logo?: { dataUrl: string }
  /** Hex colours as #RRGGBB. */
  colors?: { primary?: string; accent?: string }
  preparedBy?: string
  classification?: string
  footerText?: string
}

/** The resolved brand colours and labels every drawing call uses. Status colours are not part of it. */
export interface BrandTheme {
  /** Cover band. */
  primary: RgbColor
  /** Headings, table rules and ID tiles on white; primary darkened until it reads as text. */
  strong: RgbColor
  primaryTint: RgbColor
  /** Accent bar, donut and coverage. */
  accent: RgbColor
  /** Accent darkened until it reads as text on white. */
  accentText: RgbColor
  accentWash: RgbColor
  accentBorder: RgbColor
  onBand: RgbColor
  bandMuted: RgbColor
  bandAccent: RgbColor
  bandRule: RgbColor
  ringSoft: RgbColor
  ringStrong: RgbColor
  /** Door of the TenuVault mark on the band. */
  door: RgbColor
  /** Set only for a white label report; then no TenuVault branding is drawn. */
  companyName?: string
  logoDataUrl?: string
  preparedBy?: string
  classification?: string
  footerText?: string
}

const CHARCOAL: RgbColor = [22, 21, 20]
const CORAL: RgbColor = [228, 103, 75]
const WHITE: RgbColor = [255, 255, 255]
const BLACK: RgbColor = [0, 0, 0]

/** The TenuVault charcoal and coral theme. */
export const TENUVAULT_THEME: BrandTheme = {
  primary: CHARCOAL,
  strong: CHARCOAL,
  primaryTint: [238, 236, 233],
  accent: CORAL,
  accentText: [201, 75, 48],
  accentWash: [253, 244, 241],
  accentBorder: [247, 203, 190],
  onBand: WHITE,
  bandMuted: [210, 206, 201],
  bandAccent: [241, 167, 146],
  bandRule: mixColor(CHARCOAL, WHITE, 0.17),
  ringSoft: mixColor(CHARCOAL, CORAL, 0.14),
  ringStrong: mixColor(CHARCOAL, CORAL, 0.42),
  door: [244, 243, 241],
}

/**
 * The product name in product authored report text: the customer's company on a white label
 * report, otherwise TenuVault. Never applied to tenant data or licence text, which print as recorded.
 */
export const brandName = (theme: BrandTheme): string => theme.companyName ?? 'TenuVault'

/** A strict #RRGGBB colour, or undefined. */
export function parseHexColor(value: unknown): RgbColor | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) return undefined
  return [0, 2, 4].map(offset => parseInt(value.slice(1 + offset, 3 + offset), 16)) as RgbColor
}

/** WCAG relative luminance, 0 for black to 1 for white. */
export function luminance(color: RgbColor): number {
  const [r, g, b] = color.map(channel => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as RgbColor
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// Luminance at or below this keeps 4.5:1 contrast against white.
const TEXT_LUMINANCE = 0.18

function readable(color: RgbColor): RgbColor {
  let result = color
  for (let step = 0; step < 20 && luminance(result) > TEXT_LUMINANCE; step++) result = mixColor(result, BLACK, 0.1)
  return result
}

/** A single line label from untrusted input: control characters removed, at most 120 characters. */
function label(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Control characters are intentionally removed from single-line labels.
  // oxlint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 120) : undefined
}

function logo(value: unknown): string | undefined {
  const dataUrl = typeof value === 'object' && value !== null ? (value as { dataUrl?: unknown }).dataUrl : undefined
  return typeof dataUrl === 'string' && /^data:image\/(?:png|jpe?g);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) ? dataUrl : undefined
}

/** The full theme for a report: customer colours and labels where valid, TenuVault everywhere else, or TenuVault alone without a company name. */
export function resolveBrandTheme(branding?: PdfBranding): BrandTheme {
  if (!label(branding?.companyName)) return TENUVAULT_THEME
  const primary = parseHexColor(branding?.colors?.primary)
  const accent = parseHexColor(branding?.colors?.accent)
  const labels = {
    ...(label(branding?.companyName) ? { companyName: label(branding?.companyName) } : {}),
    ...(logo(branding?.logo) ? { logoDataUrl: logo(branding?.logo) } : {}),
    ...(label(branding?.preparedBy) ? { preparedBy: label(branding?.preparedBy) } : {}),
    ...(label(branding?.classification) ? { classification: label(branding?.classification) } : {}),
    ...(label(branding?.footerText) ? { footerText: label(branding?.footerText) } : {}),
  }
  if (!primary && !accent) return { ...TENUVAULT_THEME, ...labels }
  const band = primary ?? CHARCOAL
  const highlight = accent ?? CORAL
  const light = luminance(band) > 0.5
  const onBand = light ? CHARCOAL : WHITE
  return {
    primary: band,
    strong: primary ? readable(band) : CHARCOAL,
    primaryTint: primary ? mixColor(band, WHITE, 0.9) : TENUVAULT_THEME.primaryTint,
    accent: highlight,
    accentText: accent ? readable(highlight) : TENUVAULT_THEME.accentText,
    accentWash: accent ? mixColor(highlight, WHITE, 0.93) : TENUVAULT_THEME.accentWash,
    accentBorder: accent ? mixColor(highlight, WHITE, 0.65) : TENUVAULT_THEME.accentBorder,
    onBand,
    bandMuted: mixColor(onBand, band, 0.25),
    bandAccent: light ? readable(highlight) : mixColor(highlight, WHITE, 0.35),
    bandRule: mixColor(band, onBand, 0.17),
    ringSoft: mixColor(band, light ? BLACK : highlight, 0.14),
    ringStrong: mixColor(band, highlight, 0.42),
    door: light ? CHARCOAL : TENUVAULT_THEME.door,
    ...labels,
  }
}

const cssColor = (color: RgbColor) => `rgb(${color[0]} ${color[1]} ${color[2]})`
const kebab = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)

/**
 * CSS custom properties of a resolved theme for the HTML reports: every brand colour of the theme
 * (`--primary`, `--strong`, `--accent-text` and so on, derived tints and the light primary contrast
 * rule included), the neutral palette (`--ink`, `--rule`, ...) and the pill tones (`--good-text`,
 * `--good-fill`, ...), with exactly the values the PDF kit draws with.
 */
export function themeCssVariables(theme: BrandTheme): Record<string, string> {
  const brand = (['primary', 'strong', 'primaryTint', 'accent', 'accentText', 'accentWash', 'accentBorder', 'onBand', 'bandMuted', 'bandAccent', 'bandRule', 'ringSoft', 'ringStrong', 'door'] as const)
    .map(key => [`--${kebab(key)}`, cssColor(theme[key])])
  const palette = Object.entries(PALETTE).map(([key, color]) => [`--${kebab(key)}`, cssColor(color)])
  const tones = Object.entries(TONES).flatMap(([key, tone]) => [[`--${key}-text`, cssColor(tone.text)], [`--${key}-fill`, cssColor(tone.fill)]])
  return Object.fromEntries([...brand, ...palette, ...tones])
}
