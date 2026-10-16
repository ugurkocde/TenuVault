import { afterEach, describe, expect, it, vi } from "vitest"
import { BrandingError, LOGO_LIMIT, PDF_BRANDING_KEY, PdfBrandingPolicy, PdfBrandingStore, pdfBrandingFor, setPdfBrandingPolicy, validateBranding } from "../src/main/pdf-branding"
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
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]).toString("base64")}`
const BRANDING = { companyName: "Fabrikam Security Services", colors: { primary: "#0b3d5c", accent: "#2BB3A3" }, preparedBy: "Avery Fabrikam", classification: "Confidential", footerText: "Fabrikam | Review", logo: { dataUrl: LOGO } }
const author = (bytes: Uint8Array | Buffer) => /\/Author \(([^)]*)\)/.exec(Buffer.from(bytes).toString("latin1"))?.[1]

function policy(plans: Record<string, Plan | null>, store = memoryStore()) {
  const branding = new PdfBrandingStore(store)
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
    [{ companyName: "F", logo: { dataUrl: (() => { const bytes = Buffer.from(LOGO.split(",")[1]!, "base64"); bytes.writeUInt32BE(20_000, 16); return `data:image/png;base64,${bytes.toString("base64")}` })() } }, "4096 by 4096 pixels"],
  ])("rejects %j", (value, message) => {
    expect(() => validateBranding(value)).toThrow(BrandingError)
    expect(() => validateBranding(value)).toThrow(message)
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
