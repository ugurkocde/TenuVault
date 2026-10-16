import type { PdfBranding } from "../shared/pdf/theme"
import { allows, PlanRequired, type Plan } from "../shared/plans"
import type { KeyValueStore } from "./storage/secure-store"

/** Key of the PDF branding in the encrypted app store; kept apart from the preferences because of the logo. */
export const PDF_BRANDING_KEY = "pdf.branding"
/** Largest logo accepted, in decoded bytes. */
export const LOGO_LIMIT = 1024 * 1024
const LABEL_LIMIT = 120

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

/** A PNG or JPEG data URL whose bytes really are a PNG or a JPEG of at most 1 MB. */
function logo(value: unknown): { dataUrl: string } | undefined {
  if (value === undefined || value === null) return undefined
  const dataUrl = typeof value === "object" && !Array.isArray(value) ? (value as { dataUrl?: unknown }).dataUrl : undefined
  if (typeof dataUrl !== "string") throw new BrandingError("The logo must be a PNG or JPEG image.")
  // Base64 of 1 MB is about 1.4 million characters; refuse anything far larger before decoding.
  if (dataUrl.length > Math.ceil(LOGO_LIMIT / 3) * 4 + 64) throw new BrandingError("The logo can be at most 1 MB.")
  const match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match) throw new BrandingError("The logo must be a PNG or JPEG image.")
  const bytes = Buffer.from(match[2]!, "base64")
  if (bytes.length > LOGO_LIMIT) throw new BrandingError("The logo can be at most 1 MB.")
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (match[1] === "png" ? !png : !jpeg) throw new BrandingError("The logo file is not a valid PNG or JPEG image.")
  return { dataUrl: `data:image/${match[1] === "png" ? "png" : "jpeg"};base64,${match[2]}` }
}

/** Checks branding sent by the renderer: known fields only, labels cleaned, colors strict, the logo a real PNG or JPEG. */
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
  constructor(private readonly store: KeyValueStore) {}

  /** The saved branding, or null when none is saved or the stored value no longer validates. */
  get(): PdfBranding | null {
    try {
      const stored = this.store.get(PDF_BRANDING_KEY)
      return stored ? validateBranding(JSON.parse(stored)) : null
    } catch {
      return null
    }
  }

  set(value: unknown): PdfBranding {
    const branding = validateBranding(value)
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
