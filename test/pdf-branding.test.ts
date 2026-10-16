import { afterEach, describe, expect, it, vi } from "vitest"
import { crc32 } from "node:zlib"
import { BrandingError, LOGO_LIMIT, PDF_BRANDING_KEY, PdfBrandingPolicy, PdfBrandingStore, canonicalLogo, inspectLogo, pdfBrandingFor, setPdfBrandingPolicy, validateBranding, type LogoDecoder, type LogoImage } from "../src/main/pdf-branding"
import { prepareOibReportFile } from "../src/main/report-export"
import { handleNativeFramework, setNativeFrameworkAuthorization, setNativeFrameworkStore } from "../src/main/frameworks/native"
import { handleFramework, type ExportFile } from "../src/main/frameworks/service"
import { recordAssessment, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { PlanRequired, type Plan } from "../src/shared/plans"
import { withPlanError } from "../src/shared/plan-errors"
import type { BaselinePolicy } from "../src/shared/frameworks/policies"
import { EXPORTED_AT, TENANT_ID, oibComparisonReport, pngLogo } from "./pdf-report-fixtures"
import { pdfText } from "./pdf-text"
import { memoryStore } from "./helpers"

const LOGO = pngLogo()
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** A PNG chunk with its length and CRC; `crc` overrides the checksum. */
function chunk(type: string, data: Buffer = Buffer.alloc(0), crc?: number): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc ?? crc32(body))
  return Buffer.concat([length, body, sum])
}
function ihdr(width = 1, height = 1, depth = 8, colorType = 6): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = depth
  data[9] = colorType
  return chunk("IHDR", data)
}
const IDAT = chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60, 0, 0, 0, 2, 0, 1]))
const png = (...chunks: Buffer[]) => Buffer.concat([PNG_SIGNATURE, ...chunks])
const dataUrl = (bytes: Buffer, type = "png") => `data:image/${type};base64,${bytes.toString("base64")}`
/** A JPEG header up to its start of frame, enough for the structural check. */
function jpeg(width = 240, height = 80, frame = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.from([0xff, frame, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}
const JPEG = dataUrl(jpeg(), "jpeg")

/** A stand-in for nativeImage: reports the declared size and encodes a solid PNG of the current size. */
function fakeImage(width: number, height: number, extra: Buffer[] = []): LogoImage {
  return {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: (size) => fakeImage(size.width, size.height, extra),
    toPNG: () => {
      const bytes = Buffer.from(pngLogo(width, height).split(",")[1]!, "base64")
      // Encoders may add ancillary chunks after IHDR.
      return Buffer.concat([bytes.subarray(0, 33), ...extra, bytes.subarray(33)])
    },
  }
}
const decodeDeclared: LogoDecoder = (bytes) => {
  const size = inspectLogo(bytes, bytes[0] === 0xff ? "jpeg" : "png")
  return fakeImage(size.width, size.height)
}
const decoded = (url: string) => Buffer.from(url.split(",")[1]!, "base64")
const BRANDING = { companyName: "Fabrikam Security Services", colors: { primary: "#0b3d5c", accent: "#2BB3A3" }, preparedBy: "Avery Fabrikam", classification: "Confidential", footerText: "Fabrikam | Review", logo: { dataUrl: LOGO } }
const author = (bytes: Uint8Array | Buffer) => /\/Author \(([^)]*)\)/.exec(Buffer.from(bytes).toString("latin1"))?.[1]

function policy(plans: Record<string, Plan | null>, store = memoryStore()) {
  const branding = new PdfBrandingStore(store, decodeDeclared)
  return {
    store, branding,
    policy: new PdfBrandingPolicy(branding, async (tenantId) => {
      if (!(tenantId in plans)) throw new Error("Sign in to this tenant first.")
      return plans[tenantId]!
    }, () => Object.values(plans)),
  }
}

afterEach(() => {
  setPdfBrandingPolicy(null)
  vi.unstubAllGlobals()
})

describe("PDF branding validation", () => {
  it("cleans labels, uppercases colours and keeps a real PNG or JPEG logo", () => {
    expect(validateBranding({ ...BRANDING, companyName: "  Fabrikam\u0007 Security\nServices ", preparedBy: "", colors: { primary: "#0b3d5c" } })).toEqual({
      companyName: "Fabrikam Security Services", colors: { primary: "#0B3D5C" }, classification: "Confidential", footerText: "Fabrikam | Review", logo: { dataUrl: LOGO },
    })
    expect(validateBranding({ companyName: "Fabrikam", logo: { dataUrl: JPEG.replace("image/jpeg", "image/jpg") } }).logo).toEqual({ dataUrl: JPEG })
    expect(validateBranding({ companyName: "Fabrikam", colors: { primary: "", accent: null }, logo: null })).toEqual({ companyName: "Fabrikam" })
  })

  it.each([
    [null, "invalid"], [[], "invalid"], [{ companyName: "" }, "Enter a company name"], [{ companyName: 7 }, "must be text"],
    [{ companyName: "x".repeat(121) }, "at most 120"], [{ companyName: "F", preparedBy: "x".repeat(121) }, "at most 120"], [{ companyName: "F", footerText: { a: 1 } }, "must be text"],
    [{ companyName: "F", colors: { primary: "red" } }, "#RRGGBB"], [{ companyName: "F", colors: { accent: "#FFF" } }, "#RRGGBB"], [{ companyName: "F", colors: "navy" }, "colors are invalid"],
    [{ companyName: "F", logo: { dataUrl: "javascript:alert(1)" } }, "PNG or JPEG"], [{ companyName: "F", logo: "data:image/png;base64,AAAA" }, "PNG or JPEG"],
    [{ companyName: "F", logo: { dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" } }, "PNG or JPEG"],
    [{ companyName: "F", logo: { dataUrl: LOGO.replace("image/png", "image/jpeg") } }, "not a valid PNG or JPEG"],
    [{ companyName: "F", logo: { dataUrl: JPEG.replace("image/jpeg", "image/png") } }, "not a valid PNG or JPEG"],
    [{ companyName: "F", logo: { dataUrl: `data:image/png;base64,${Buffer.alloc(LOGO_LIMIT + 3).toString("base64")}` } }, "at most 1 MB"],
    [{ companyName: "F", logo: { dataUrl: `data:image/png;base64,${"A".repeat(2_000_000)}` } }, "at most 1 MB"],
    [{ companyName: "F", extra: true }, "invalid"],
    [{ companyName: "F", logo: { dataUrl: dataUrl(png(ihdr(20_000, 10), IDAT, chunk("IEND"))) } }, "2048 by 2048 pixels"],
  ])("rejects %j", (value, message) => {
    expect(() => validateBranding(value)).toThrow(BrandingError)
    expect(() => validateBranding(value)).toThrow(message)
  })
})

describe("logo structural check", () => {
  it("accepts a plain PNG and a JPEG and reads their declared size", () => {
    expect(inspectLogo(decoded(LOGO), "png")).toEqual({ width: 240, height: 80 })
    expect(inspectLogo(png(ihdr(2048, 2048), chunk("sRGB", Buffer.from([0])), chunk("pHYs", Buffer.alloc(9)), IDAT, IDAT, chunk("IEND")), "png")).toEqual({ width: 2048, height: 2048 })
    expect(inspectLogo(jpeg(), "jpeg")).toEqual({ width: 240, height: 80 })
    // Progressive JPEG, fill bytes before a marker and a restart marker are fine.
    expect(inspectLogo(jpeg(640, 200, 0xc2), "jpeg")).toEqual({ width: 640, height: 200 })
    const padded = jpeg()
    expect(inspectLogo(Buffer.concat([padded.subarray(0, 2), Buffer.from([0xff, 0xd0]), Buffer.from([0xff]), padded.subarray(2)]), "jpeg")).toEqual({ width: 240, height: 80 })
  })

  it.each([
    ["a second IHDR", png(ihdr(), ihdr(4000, 4000), IDAT, chunk("IEND"))],
    ["an IHDR that is not first", png(chunk("sRGB", Buffer.from([0])), ihdr(), IDAT, chunk("IEND"))],
    ["an ICC profile", png(ihdr(), chunk("iCCP", Buffer.concat([Buffer.from("icc\0\0"), Buffer.alloc(4096)])), IDAT, chunk("IEND"))],
    ["a text chunk", png(ihdr(), chunk("tEXt", Buffer.from("Comment\0hello")), IDAT, chunk("IEND"))],
    ["a compressed text chunk", png(ihdr(), chunk("zTXt", Buffer.from("Comment\0\0x")), IDAT, chunk("IEND"))],
    ["an international text chunk", png(ihdr(), chunk("iTXt", Buffer.from("Comment\0\0\0\0\0x")), IDAT, chunk("IEND"))],
    ["an unknown chunk", png(ihdr(), chunk("eXIf", Buffer.alloc(8)), IDAT, chunk("IEND"))],
    ["a bad CRC", png(ihdr(), chunk("IDAT", Buffer.from([1, 2, 3]), 0xdeadbeef), chunk("IEND"))],
    ["a truncated chunk", png(ihdr(), IDAT.subarray(0, IDAT.length - 3))],
    ["a chunk longer than the file", Buffer.concat([png(ihdr()), Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from("IDAT")])],
    ["no image data", png(ihdr(), chunk("IEND"))],
    ["no IEND", png(ihdr(), IDAT)],
    ["data after IEND", Buffer.concat([png(ihdr(), IDAT, chunk("IEND")), Buffer.from([0])])],
    ["an IEND with data", png(ihdr(), IDAT, chunk("IEND", Buffer.from([0])))],
    ["an IHDR of the wrong length", png(chunk("IHDR", Buffer.alloc(12)), IDAT, chunk("IEND"))],
    ["an invalid bit depth", png(ihdr(1, 1, 3), IDAT, chunk("IEND"))],
    ["an invalid colour type", png(ihdr(1, 1, 8, 5), IDAT, chunk("IEND"))],
    ["zero width", png(ihdr(0, 10), IDAT, chunk("IEND"))],
    ["a bad signature", Buffer.concat([Buffer.from("GIF89a\0\0"), ihdr(), IDAT, chunk("IEND")])],
  ])("rejects a PNG with %s", (_name, bytes) => {
    expect(() => inspectLogo(bytes, "png")).toThrow(BrandingError)
    expect(() => validateBranding({ companyName: "F", logo: { dataUrl: dataUrl(bytes) } })).toThrow(BrandingError)
  })

  it("rejects PNG and JPEG dimensions over 2048 pixels", () => {
    expect(() => inspectLogo(png(ihdr(2049, 10), IDAT, chunk("IEND")), "png")).toThrow("at most 2048 by 2048 pixels")
    expect(() => inspectLogo(png(ihdr(10, 0x7fffffff), IDAT, chunk("IEND")), "png")).toThrow("at most 2048 by 2048 pixels")
    expect(() => inspectLogo(jpeg(4000, 100), "jpeg")).toThrow("at most 2048 by 2048 pixels")
  })

  it.each([
    ["no start of image", Buffer.from([0x00, 0xd8, 0xff, 0xe0])],
    ["a scan before any frame", Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])],
    ["an end before any frame", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ["a segment longer than the file", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x40, 0x00, 0x00])],
    ["a segment length below two", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01])],
    ["a cut length", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
    ["garbage between segments", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), Buffer.from([0x12, 0x34])])],
    ["a short frame header", Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04, 0x08, 0x00])],
    ["zero height", jpeg(10, 0)],
    ["too many segments", Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 200 }, () => Buffer.from([0xff, 0xfe, 0x00, 0x02])), jpeg().subarray(2)])],
    ["no frame at all", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02])],
  ])("rejects a JPEG with %s", (_name, bytes) => {
    expect(() => inspectLogo(bytes, "jpeg")).toThrow(BrandingError)
  })
})

describe("logo re-encoding", () => {
  it("stores a re-encoded PNG, scaled so its longest side is at most 1200 pixels", () => {
    const sizes: Array<{ width: number; height: number }> = []
    const decode: LogoDecoder = (bytes) => {
      const size = inspectLogo(bytes, bytes[0] === 0xff ? "jpeg" : "png")
      sizes.push(size)
      return fakeImage(size.width, size.height)
    }
    const wide = canonicalLogo({ dataUrl: dataUrl(png(ihdr(2000, 500), IDAT, chunk("IEND"))) }, decode)!
    expect(wide.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
    expect(inspectLogo(decoded(wide.dataUrl), "png")).toEqual({ width: 1200, height: 300 })
    const tall = canonicalLogo({ dataUrl: dataUrl(jpeg(300, 1800), "jpeg") }, decode)!
    expect(tall.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
    expect(inspectLogo(decoded(tall.dataUrl), "png")).toEqual({ width: 200, height: 1200 })
    // A small logo keeps its size.
    expect(inspectLogo(decoded(canonicalLogo({ dataUrl: LOGO }, decode)!.dataUrl), "png")).toEqual({ width: 240, height: 80 })
    expect(sizes).toEqual([{ width: 2000, height: 500 }, { width: 300, height: 1800 }, { width: 240, height: 80 }])
    expect(canonicalLogo(undefined, decode)).toBeUndefined()
  })

  it("drops ancillary chunks an encoder adds, so the stored logo passes the check on read", () => {
    const decode: LogoDecoder = () => fakeImage(240, 80, [chunk("iCCP", Buffer.alloc(64)), chunk("tEXt", Buffer.from("Software\0x"))])
    const logo = canonicalLogo({ dataUrl: LOGO }, decode)!
    expect(decoded(logo.dataUrl).includes(Buffer.from("iCCP"))).toBe(false)
    expect(decoded(logo.dataUrl).includes(Buffer.from("tEXt"))).toBe(false)
    expect(validateBranding({ companyName: "F", logo }).logo).toEqual(logo)
  })

  it.each<[string, LogoDecoder, string]>([
    ["the decoder fails", () => { throw new Error("decode failed") }, "not a valid PNG or JPEG"],
    ["the image is empty", () => fakeImage(0, 0), "not a valid PNG or JPEG"],
    ["the decoded size differs from the header", () => fakeImage(241, 80), "not a valid PNG or JPEG"],
    ["the encoded PNG is over 1 MB", () => ({ ...fakeImage(240, 80), toPNG: () => png(ihdr(240, 80), chunk("IDAT", Buffer.alloc(LOGO_LIMIT)), chunk("IEND")) }), "too detailed"],
  ])("rejects a logo when %s", (_name, decode, message) => {
    expect(() => canonicalLogo({ dataUrl: LOGO }, decode)).toThrow(BrandingError)
    expect(() => canonicalLogo({ dataUrl: LOGO }, decode)).toThrow(message)
  })

  it("re-encodes the logo when branding is saved and treats a stored logo that fails the check as no branding", () => {
    const store = memoryStore()
    const branding = new PdfBrandingStore(store, () => fakeImage(240, 80))
    const saved = branding.set({ companyName: "F", logo: { dataUrl: JPEG } })
    expect(saved.logo?.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
    expect(JSON.parse(store.get(PDF_BRANDING_KEY)!).logo).toEqual(saved.logo)
    expect(branding.get()).toEqual(saved)
    store.set(PDF_BRANDING_KEY, JSON.stringify({ companyName: "F", logo: { dataUrl: dataUrl(png(ihdr(), ihdr(4000, 4000), IDAT, chunk("IEND"))) } }))
    expect(branding.get()).toBeNull()
  })
})

describe("PDF branding storage and plan enforcement", () => {
  it("stores branding under its own key, reads it back and clears it", () => {
    const { store, branding } = policy({})
    expect(branding.get()).toBeNull()
    branding.set(BRANDING)
    expect(JSON.parse(store.get(PDF_BRANDING_KEY)!).companyName).toBe("Fabrikam Security Services")
    expect(store.get("app.preferences")).toBeNull()
    expect(branding.get()?.colors).toEqual({ primary: "#0B3D5C", accent: "#2BB3A3" })
    branding.clear()
    expect(branding.get()).toBeNull()
    store.set(PDF_BRANDING_KEY, "{not json")
    expect(branding.get()).toBeNull()
    store.set(PDF_BRANDING_KEY, JSON.stringify({ companyName: "F", colors: { primary: "evil" } }))
    expect(branding.get()).toBeNull()
  })

  it("applies saved branding only to tenants on Pro or MSP", async () => {
    const community = "11111111-1111-1111-1111-111111111111"
    const { policy: rules, branding } = policy({ [TENANT_ID]: "pro", [community]: "community", msp: "msp", none: null })
    branding.set(BRANDING)
    expect((await rules.forTenant(TENANT_ID))?.companyName).toBe("Fabrikam Security Services")
    expect(await rules.forTenant("msp")).toMatchObject({ companyName: "Fabrikam Security Services" })
    expect(await rules.forTenant(community)).toBeUndefined()
    expect(await rules.forTenant("none")).toBeUndefined()
    expect(await rules.forTenant("unknown")).toBeUndefined()
    expect(await pdfBrandingFor(TENANT_ID)).toBeUndefined()
    setPdfBrandingPolicy(rules)
    expect(await pdfBrandingFor(TENANT_ID)).toMatchObject({ companyName: "Fabrikam Security Services" })
    expect(await pdfBrandingFor(community)).toBeUndefined()
  })

  it("saves branding only when a tenant on this machine is on Pro or MSP, and always allows a reset", async () => {
    const { policy: rules, branding } = policy({ a: "community", b: null })
    expect(rules.available()).toBe(false)
    expect(() => rules.set(BRANDING)).toThrow(PlanRequired)
    expect(await withPlanError(() => rules.set(BRANDING))).toEqual({ planError: { code: "plan_required", message: expect.stringContaining("Pro and MSP"), upgrade: "pdfBranding" } })
    // Branding saved under an earlier plan stays stored but inactive, and can still be removed.
    branding.set(BRANDING)
    expect(rules.get()?.companyName).toBe("Fabrikam Security Services")
    rules.clear()
    expect(rules.get()).toBeNull()
    const paid = policy({ a: "community", b: "pro" }).policy
    expect(paid.available()).toBe(true)
    expect(paid.set(BRANDING).companyName).toBe("Fabrikam Security Services")
    expect(() => paid.set({ companyName: "" })).toThrow(BrandingError)
  })
})

describe("PDF exports use the branding of the tenant's plan", () => {
  it("generates an OIB report in main with branding on Pro and the TenuVault design on Community", async () => {
    const plans: Record<string, Plan> = { [TENANT_ID]: "community" }
    const { policy: rules, branding } = policy(plans)
    branding.set(BRANDING)
    setPdfBrandingPolicy(rules)
    const community = await prepareOibReportFile(oibComparisonReport(), "OIB comparison Contoso <2026>.pdf", EXPORTED_AT)
    expect(community).toMatchObject({ name: "OIB comparison Contoso _2026_.pdf", extension: "pdf", label: "PDF" })
    expect(community.content.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    expect(author(community.content)).toBe("TenuVault")
    plans[TENANT_ID] = "pro"
    const pro = await prepareOibReportFile(oibComparisonReport(), "OIB comparison", EXPORTED_AT)
    expect(pro.name).toBe("OIB comparison.pdf")
    expect(author(pro.content)).toBe("Fabrikam Security Services")
    expect(pdfText(pro.content)).not.toContain("TenuVault")
    expect((await prepareOibReportFile(oibComparisonReport(), undefined, EXPORTED_AT)).name).toBe("TenuVault report.pdf")
    await expect(prepareOibReportFile("<!doctype html><p>x</p>", "x.pdf")).rejects.toThrow("The report could not be prepared")
    await expect(prepareOibReportFile({ ...oibComparisonReport(), tenantId: "x" }, "x.pdf")).rejects.toThrow("tenant ID")
  })

  it("brands native and policy pack PDF exports only for a tenant on Pro or MSP", async () => {
    const plans: Record<string, Plan> = { [TENANT_ID]: "community" }
    const { policy: rules, branding } = policy(plans)
    branding.set(BRANDING)
    setPdfBrandingPolicy(rules)
    setNativeFrameworkAuthorization(async () => plans[TENANT_ID])
    setNativeFrameworkStore(memoryStore())
    setFrameworkStore(memoryStore())
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => String(input).includes("login.microsoftonline.com") ? Response.json({ access_token: "mock-token" }) : Response.json({ value: [] })))
    const body = { tenantId: TENANT_ID, appId: "22222222-2222-2222-2222-222222222222", frameworkId: "iso-27001", tenantName: "Contoso" }
    const run = (await (await handleNativeFramework({ ...body, action: "native-assess" })).json()).run
    const pack: BaselinePolicy = { name: "Baseline", platforms: "windows10", technologies: "mdm", description: "", settings: [{ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "setting_one" } }] }
    const saved = { assessment: { runId: "run-1", tenantId: TENANT_ID, frameworkId: "custom", reference: "Profile v1", assessedAt: "2026-10-14T08:00:00Z", policyCount: 1, findings: [{ key: "0:0", policyIndex: 0, settingIndex: 0, policyName: "Baseline", settingId: "setting_one", status: "Missing" as const, recommended: { value: "x" }, observed: [] }] } }
    recordAssessment(saved.assessment, [pack])
    const nativePdf = async () => Buffer.from(await (await handleNativeFramework({ ...body, action: "native-pdf", runId: run.runId })).arrayBuffer())
    const packPdf = async () => Buffer.from(((await handleFramework({ action: "workspace-pdf", tenantId: TENANT_ID, frameworkId: "custom", runId: saved.assessment.runId })) as { file: ExportFile }).file.data, "base64")
    expect(author(await nativePdf())).toBe("TenuVault")
    expect(author(await packPdf())).toBe("TenuVault")
    plans[TENANT_ID] = "msp"
    expect(author(await nativePdf())).toBe("Fabrikam Security Services")
    expect(author(await packPdf())).toBe("Fabrikam Security Services")
  })
})
