import { describe, expect, it, vi } from "vitest"
import { anyTenantIncludes, entryBadgeFeature, selectedTenantPlan } from "../src/renderer/lib/selected-plan"
import type { LicenseStatus, TenantLicenseStatus } from "../src/shared/ipc"

vi.mock("../src/renderer/lib/bridge", () => ({ bridge: {} }))

function tenant(tenantId: string, extra: Partial<TenantLicenseStatus>): TenantLicenseStatus {
  return { tenantId, signedIn: true, activated: true, entitled: true, source: "key", plan: "pro", tenants: 2, expiresAt: "2030-01-01T00:00:00.000Z", validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null, ...extra } as TenantLicenseStatus
}

function status(plan: LicenseStatus["plan"], tenants: TenantLicenseStatus[]): LicenseStatus {
  return { hasKey: plan !== null, keyState: plan ? "active" : "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan, tenantLimit: plan ? 2 : null, validUntil: null, communityTenantId: null, tenants } as LicenseStatus
}

const NONE: ReadonlySet<string> = new Set()

describe("selectedTenantPlan", () => {
  it("is unknown while the license status loads, whatever the tenant", () => {
    expect(selectedTenantPlan(null, undefined, NONE)).toBeUndefined()
    expect(selectedTenantPlan(null, "t-pro", new Set(["t-pro"]))).toBeUndefined()
  })

  it("uses the plan of a tenant the status lists as signed in, matching its id case-insensitively", () => {
    const machine = status("pro", [tenant("t-pro", {}), tenant("t-community", { activated: false, entitled: false, source: null, plan: "community" })])
    expect(selectedTenantPlan(machine, "T-PRO", NONE)).toBe("pro")
    expect(selectedTenantPlan(machine, "t-community", undefined)).toBe("community")
  })

  it("is null for a signed-in tenant whose plan cannot be used, even on a machine with a Pro key", () => {
    expect(selectedTenantPlan(status("pro", [tenant("t-lapsed", { entitled: false })]), "t-lapsed", new Set(["t-lapsed"]))).toBeNull()
  })

  it("is unknown for a signed-in tenant the status does not list, or lists as not signed in, yet", () => {
    expect(selectedTenantPlan(status("pro", []), "t-new", new Set(["t-new"]))).toBeUndefined()
    expect(selectedTenantPlan(status("msp", [tenant("t-new", { signedIn: false })]), "T-NEW", new Set(["t-new"]))).toBeUndefined()
  })

  it("is unknown for a tenant the status does not list as signed in while the account store is not read yet", () => {
    expect(selectedTenantPlan(status("pro", []), "t-saved", undefined)).toBeUndefined()
    expect(selectedTenantPlan(status("pro", [tenant("t-saved", { signedIn: false })]), "t-saved", undefined)).toBeUndefined()
  })

  it("uses the machine plan for a saved tenant that is not signed in, listed or not", () => {
    expect(selectedTenantPlan(status("msp", []), "t-saved", NONE)).toBe("msp")
    expect(selectedTenantPlan(status(null, []), "t-saved", new Set(["t-other"]))).toBeNull()
    // A lapsed activation stored for a tenant nobody is signed in to does not decide the plan.
    expect(selectedTenantPlan(status("msp", [tenant("t-lapsed", { signedIn: false, entitled: false })]), "t-lapsed", NONE)).toBe("msp")
    expect(selectedTenantPlan(status("pro", [tenant("t-msp", { signedIn: false, plan: "msp" })]), "t-msp", NONE)).toBe("pro")
  })

  it("falls back to the machine plan with no tenant", () => {
    expect(selectedTenantPlan(status("msp", []), undefined, undefined)).toBe("msp")
    expect(selectedTenantPlan(status(null, []), undefined, NONE)).toBeNull()
  })
})

describe("anyTenantIncludes", () => {
  const community = (tenantId: string, extra: Partial<TenantLicenseStatus> = {}) => tenant(tenantId, { activated: false, entitled: false, source: null, plan: "community", ...extra })

  it("is unknown while the license status loads", () => {
    expect(anyTenantIncludes(null, NONE, "pdfBranding")).toBeUndefined()
  })

  it("is true when a tenant on this computer has a plan that includes the feature, signed in or not", () => {
    expect(anyTenantIncludes(status(null, [community("t-c"), tenant("t-pro", { signedIn: false })]), undefined, "pdfBranding")).toBe(true)
  })

  it("is false once every signed-in tenant is listed as signed in and none includes the feature", () => {
    expect(anyTenantIncludes(status(null, [community("t-c")]), new Set(["t-c"]), "pdfBranding")).toBe(false)
    expect(anyTenantIncludes(status(null, []), NONE, "notifications")).toBe(false)
  })

  it("is unknown while a signed-in tenant is not listed as signed in yet, or the account store is not read", () => {
    expect(anyTenantIncludes(status(null, [community("t-c")]), new Set(["t-c", "t-new"]), "pdfBranding")).toBeUndefined()
    expect(anyTenantIncludes(status(null, [community("t-c"), tenant("t-new", { signedIn: false })]), new Set(["t-c", "t-new"]), "pdfBranding")).toBe(true)
    expect(anyTenantIncludes(status(null, [community("t-c"), tenant("t-new", { signedIn: false, entitled: false })]), new Set(["t-c", "t-new"]), "pdfBranding")).toBeUndefined()
    expect(anyTenantIncludes(status(null, [community("t-c")]), undefined, "pdfBranding")).toBeUndefined()
  })
})

describe("entryBadgeFeature", () => {
  it("shows no badge while the plan is not known", () => {
    expect(entryBadgeFeature(undefined, ["auditLog"])).toBeNull()
  })

  it("names the lowest plan among the features when the plan includes none of them", () => {
    expect(entryBadgeFeature("community", ["goldenStandards", "baselineScores"])).toBe("baselineScores")
    expect(entryBadgeFeature("community", ["bulkActions", "portfolio"])).toBe("bulkActions")
    expect(entryBadgeFeature("pro", ["goldenStandards", "portfolio"])).toBe("goldenStandards")
  })

  it("shows no badge when the plan includes at least one of the features", () => {
    expect(entryBadgeFeature("pro", ["goldenStandards", "baselineScores"])).toBeNull()
    expect(entryBadgeFeature("msp", ["goldenStandards"])).toBeNull()
  })

  it("marks an entry for a tenant whose plan cannot be used", () => {
    expect(entryBadgeFeature(null, ["customBaselines"])).toBe("customBaselines")
  })
})
