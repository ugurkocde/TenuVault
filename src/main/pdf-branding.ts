import { crc32 } from "node:zlib"
import type { PdfBranding } from "../shared/pdf/theme"
import { allows, PlanRequired, type Plan } from "../shared/plans"
import type { KeyValueStore } from "./storage/secure-store"

/** Key of the PDF branding in the encrypted app store; kept apart from the preferences because of the logo. */
export const PDF_BRANDING_KEY = "pdf.branding"
/** Largest logo accepted, in decoded bytes. */
export const LOGO_LIMIT = 1024 * 1024
const LABEL_LIMIT = 120
/** Largest logo accepted, in pixels on each side. */
export const LOGO_PIXELS = 2048
// Longest side of the stored logo; the cover prints it at most 44 mm wide.
const LOGO_SIDE = 1200

/** Thrown for branding the admin entered that cannot be saved; the message says what to change. */
export class BrandingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrandingError"
  }
}

/** A single line label: control characters removed, at most 120 characters, or undefined when empty. */
function label(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new BrandingError(`${name} must be text.`)
  // Control characters are intentionally removed from single-line labels.
  // oxlint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  if (text.length > LABEL_LIMIT) throw new BrandingError(`${name} can be at most ${LABEL_LIMIT} characters.`)
  return text || undefined
}

function color(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new BrandingError(`${name} must be a color in the form #RRGGBB.`)
  return value.toUpperCase()
}

// PNG chunks a logo keeps. Other ancillary chunks (ICC profiles, text, EXIF, which screenshots and
// design tools add) are accepted but dropped before decoding; unknown critical chunks are refused.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "sRGB", "gAMA", "cHRM", "pHYs"])
// JPEG start of frame markers (SOF0 to SOF15 without DHT, JPG and DAC), which carry the image size.
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const JPEG_SEGMENTS = 128

/** Width and height a logo declares in its header, after a structural check of the whole file; throws BrandingError otherwise. */
export function inspectLogo(bytes: Buffer, format: "png" | "jpeg"): { width: number; height: number } {
  const size = format === "png" ? inspectPng(bytes) : inspectJpeg(bytes)
  if (!size) throw new BrandingError("The logo file is not a valid PNG or JPEG image.")
  if (size.width < 1 || size.height < 1) throw new BrandingError("The logo file is not a valid PNG or JPEG image.")
  if (size.width > LOGO_PIXELS || size.height > LOGO_PIXELS) throw new BrandingError(`The logo can be at most ${LOGO_PIXELS} by ${LOGO_PIXELS} pixels.`)
  return size
}

/**
 * Walks every chunk: lengths inside the file, CRCs correct, one IHDR first, only the chunks a plain
 * image needs, image data present and IEND last at the very end. Undefined when any check fails.
 */
function inspectPng(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  let offset = 8
  let size: { width: number; height: number } | undefined
  let data = false
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return undefined
    const length = bytes.readUInt32BE(offset)
    if (length > bytes.length - offset - 12) return undefined
    const type = bytes.toString("latin1", offset + 4, offset + 8)
    const body = bytes.subarray(offset + 4, offset + 8 + length)
    if (crc32(body) !== bytes.readUInt32BE(offset + 8 + length)) return undefined
    if (!PNG_CHUNKS.has(type) && !ancillary(type)) return undefined
    if ((type === "IHDR") !== (offset === 8)) return undefined
    if (type === "IHDR") {
      if (length !== 13) return undefined
      const [depth, colorType, compression, filter, interlace] = bytes.subarray(offset + 16, offset + 21)
      if (![1, 2, 4, 8, 16].includes(depth!) || ![0, 2, 3, 4, 6].includes(colorType!) || compression !== 0 || filter !== 0 || interlace! > 1) return undefined
      size = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) }
    }
    if (type === "IDAT") data = true
    offset += length + 12
    if (type === "IEND") return length === 0 && data && offset === bytes.length ? size : undefined
  }
  return undefined
}

/** An ancillary chunk: a lowercase first letter, which a decoder may skip. */
const ancillary = (type: string) => /^[a-z][A-Za-z]{3}$/.test(type)

/** Walks the segments up to the first start of frame and reads its size; undefined when the file ends or misbehaves first. */
function inspectJpeg(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  for (let segments = 0; segments < JPEG_SEGMENTS; segments++) {
    if (bytes[offset] !== 0xff) return undefined
    // Fill bytes may pad a marker.
    while (bytes[offset] === 0xff && offset < bytes.length) offset++
    const marker = bytes[offset]
    offset++
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return undefined
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return undefined
    if (JPEG_FRAMES.has(marker)) return length >= 7 ? { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) } : undefined
    offset += length
  }
  return undefined
}

/** A PNG or JPEG data URL of at most 1 MB whose bytes pass the structural check; the format and the bytes. */
function logoBytes(value: unknown): { format: "png" | "jpeg"; bytes: Buffer } | undefined {
  if (value === undefined || value === null) return undefined
  const dataUrl = typeof value === "object" && !Array.isArray(value) ? (value as { dataUrl?: unknown }).dataUrl : undefined
  if (typeof dataUrl !== "string") throw new BrandingError("The logo must be a PNG or JPEG image.")
  // Base64 of 1 MB is about 1.4 million characters; refuse anything far larger before decoding.
  if (dataUrl.length > Math.ceil(LOGO_LIMIT / 3) * 4 + 64) throw new BrandingError("The logo can be at most 1 MB.")
  const match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match) throw new BrandingError("The logo must be a PNG or JPEG image.")
  const bytes = Buffer.from(match[2]!, "base64")
  if (bytes.length > LOGO_LIMIT) throw new BrandingError("The logo can be at most 1 MB.")
  const format = match[1] === "png" ? "png" : "jpeg"
  inspectLogo(bytes, format)
  return { format, bytes }
}

/** The part of Electron's nativeImage the logo needs; injected so the checks run without Electron. */
export interface LogoImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality?: "good" | "better" | "best" }): LogoImage
  toPNG(): Buffer
}

/** Decodes image bytes; nativeImage.createFromBuffer in the app. */
export type LogoDecoder = (bytes: Buffer) => LogoImage

/** Keeps only the chunks inspectPng allows, so an encoder that adds a profile or text still yields a logo that passes. */
function keepPlainChunks(png: Buffer): Buffer {
  const parts: Buffer[] = [PNG_SIGNATURE]
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset)
    if (PNG_CHUNKS.has(png.toString("latin1", offset + 4, offset + 8))) parts.push(png.subarray(offset, offset + length + 12))
    offset += length + 12
  }
  return Buffer.concat(parts)
}

/**
 * The logo as the app stores it: checked structurally, decoded within its declared size, scaled so
 * its longest side is at most 1200 pixels and encoded again as a plain PNG. Only this re-encoded
 * PNG ever reaches the PDF engines, so they never decode an uploaded file.
 */
export function canonicalLogo(value: unknown, decode: LogoDecoder): { dataUrl: string } | undefined {
  const logo = logoBytes(value)
  if (!logo) return undefined
  const declared = inspectLogo(logo.bytes, logo.format)
  let image: LogoImage
  try {
    // Dropped ancillary chunks never reach the decoder, so a compressed profile or text is never inflated.
    image = decode(logo.format === "png" ? keepPlainChunks(logo.bytes) : logo.bytes)
  } catch {
    throw new BrandingError("The logo file is not a valid PNG or JPEG image.")
  }
  const actual = image.isEmpty() ? { width: 0, height: 0 } : image.getSize()
  if (actual.width !== declared.width || actual.height !== declared.height) throw new BrandingError("The logo file is not a valid PNG or JPEG image.")
  const scale = Math.min(1, LOGO_SIDE / Math.max(actual.width, actual.height))
  const width = Math.max(1, Math.round(actual.width * scale))
  const height = Math.max(1, Math.round(actual.height * scale))
  const png = keepPlainChunks((scale < 1 ? image.resize({ width, height, quality: "best" }) : image).toPNG())
  if (png.length > LOGO_LIMIT) throw new BrandingError("The logo is too detailed to store; use a simpler or smaller image.")
  inspectLogo(png, "png")
  return { dataUrl: `data:image/png;base64,${png.toString("base64")}` }
}

/** A stored logo that still passes the structural check, as a normalised data URL. */
function logo(value: unknown): { dataUrl: string } | undefined {
  const checked = logoBytes(value)
  const bytes = checked?.format === "png" ? keepPlainChunks(checked.bytes) : checked?.bytes
  return checked && bytes && { dataUrl: `data:image/${checked.format};base64,${bytes.toString("base64")}` }
}

/** Checks branding sent by the renderer or read back from the store: known fields only, labels cleaned, colors strict, the logo structurally a plain PNG or JPEG. */
export function validateBranding(value: unknown): PdfBranding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BrandingError("The branding settings are invalid.")
  const input = value as Record<string, unknown>
  const unknown = Object.keys(input).find((key) => !["companyName", "logo", "colors", "preparedBy", "classification", "footerText"].includes(key))
  if (unknown) throw new BrandingError("The branding settings are invalid.")
  const companyName = label(input.companyName, "Company name")
  if (!companyName) throw new BrandingError("Enter a company name; branded reports carry it instead of TenuVault.")
  const colors = input.colors
  if (colors !== undefined && (typeof colors !== "object" || colors === null || Array.isArray(colors))) throw new BrandingError("The colors are invalid.")
  const primary = color((colors as Record<string, unknown> | undefined)?.primary, "Primary color")
  const accent = color((colors as Record<string, unknown> | undefined)?.accent, "Accent color")
  const image = logo(input.logo)
  const preparedBy = label(input.preparedBy, "Prepared by")
  const classification = label(input.classification, "Classification")
  const footerText = label(input.footerText, "Footer text")
  return {
    companyName,
    ...(image && { logo: image }),
    ...((primary || accent) && { colors: { ...(primary && { primary }), ...(accent && { accent }) } }),
    ...(preparedBy && { preparedBy }),
    ...(classification && { classification }),
    ...(footerText && { footerText }),
  }
}

/** The saved PDF branding in the encrypted app store. */
export class PdfBrandingStore {
  constructor(
    private readonly store: KeyValueStore,
    /** Decodes an uploaded logo so it can be stored as a re-encoded PNG. */
    private readonly decodeLogo: LogoDecoder,
  ) {}

  /** The saved branding, or null when none is saved or the stored value no longer validates. */
  get(): PdfBranding | null {
    try {
      const stored = this.store.get(PDF_BRANDING_KEY)
      return stored ? validateBranding(JSON.parse(stored)) : null
    } catch {
      return null
    }
  }

  /** Checks the branding and stores it with the logo re-encoded; throws BrandingError for anything that cannot be saved. */
  set(value: unknown): PdfBranding {
    const checked = validateBranding(value)
    const image = checked.logo && canonicalLogo(checked.logo, this.decodeLogo)
    const branding: PdfBranding = { ...checked, ...(image && { logo: image }) }
    this.store.set(PDF_BRANDING_KEY, JSON.stringify(branding))
    return branding
  }

  clear(): void {
    this.store.delete(PDF_BRANDING_KEY)
  }
}

/**
 * Plan enforcement of PDF branding. Exports resolve the branding of the tenant they describe at
 * generation time: the saved branding only when that tenant's plan includes pdfBranding, otherwise
 * none, so a Community tenant never gets a branded report even when branding is saved.
 */
export class PdfBrandingPolicy {
  constructor(
    private readonly branding: PdfBrandingStore,
    /** The tenant's plan from the license service, as the API plan guard resolves it; rejects when unusable. */
    private readonly planOf: (tenantId: string) => Promise<Plan | null>,
    /** The plans of every tenant known to this machine, for the Settings page. */
    private readonly plans: () => Array<Plan | null>,
  ) {}

  /** The branding for an export of this tenant, or undefined for the TenuVault design. */
  async forTenant(tenantId: string): Promise<PdfBranding | undefined> {
    const plan = await this.planOf(tenantId).catch(() => null)
    if (!plan || !allows(plan, "pdfBranding")) return undefined
    return this.branding.get() ?? undefined
  }

  /** Whether any tenant on this machine is on a plan with pdfBranding. */
  available(): boolean {
    return this.plans().some((plan) => plan !== null && allows(plan, "pdfBranding"))
  }

  get(): PdfBranding | null {
    return this.branding.get()
  }

  /** Saves branding when a tenant on this machine may use it; throws PlanRequired otherwise. */
  set(value: unknown): PdfBranding {
    if (!this.available()) throw new PlanRequired("pdfBranding")
    return this.branding.set(value)
  }

  /** Back to the TenuVault design; always allowed, also after a plan ended. */
  clear(): void {
    this.branding.clear()
  }
}

let policy: PdfBrandingPolicy | null = null

/** Installs the branding policy every PDF export uses. */
export function setPdfBrandingPolicy(value: PdfBrandingPolicy | null): void {
  policy = value
}

/** The branding for a PDF export of this tenant; undefined (the TenuVault design) without a policy. */
export async function pdfBrandingFor(tenantId: string): Promise<PdfBranding | undefined> {
  return policy ? policy.forTenant(tenantId) : undefined
}
