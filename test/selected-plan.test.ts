import { describe, expect, it, vi } from "vitest"
import { entryBadgeFeature, selectedTenantPlan } from "../src/renderer/lib/selected-plan"
import type { LicenseStatus, TenantLicenseStatus } from "../src/shared/ipc"

vi.mock("../src/renderer/lib/bridge", () => ({ bridge: {} }))

function tenant(tenantId: string, extra: Partial<TenantLicenseStatus>): TenantLicenseStatus {
  return { tenantId, signedIn: true, activated: true, entitled: true, source: "key", plan: "pro", tenants: 2, expiresAt: "2030-01-01T00:00:00.000Z", validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null, ...extra } as TenantLicenseStatus
}

function status(plan: LicenseStatus["plan"], tenants: TenantLicenseStatus[]): LicenseStatus {
  return { hasKey: plan !== null, keyState: plan ? "active" : "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan, tenantLimit: plan ? 2 : null, validUntil: null, communityTenantId: null, tenants } as LicenseStatus
}

describe("selectedTenantPlan", () => {
  it("is unknown while the license status loads, whatever the tenant", () => {
    expect(selectedTenantPlan(null, undefined)).toBeUndefined()
    expect(selectedTenantPlan(null, "t-pro")).toBeUndefined()
  })

  it("uses the plan of a signed-in tenant the status lists, matching its id case-insensitively", () => {
    const machine = status("pro", [tenant("t-pro", {}), tenant("t-community", { activated: false, entitled: false, source: null, plan: "community" })])
    expect(selectedTenantPlan(machine, "T-PRO")).toBe("pro")
    expect(selectedTenantPlan(machine, "t-community")).toBe("community")
  })

  it("is null for a listed tenant whose plan cannot be used, even on a machine with a Pro key", () => {
    expect(selectedTenantPlan(status("pro", [tenant("t-lapsed", { entitled: false })]), "t-lapsed")).toBeNull()
  })

  it("is unknown for a signed-in tenant the status does not list yet", () => {
    expect(selectedTenantPlan(status("pro", []), "t-new")).toBeUndefined()
  })

  it("falls back to the machine plan with no signed-in tenant", () => {
    expect(selectedTenantPlan(status("msp", []), undefined)).toBe("msp")
    expect(selectedTenantPlan(status(null, []), undefined)).toBeNull()
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
