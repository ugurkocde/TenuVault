import { describe, expect, it, vi } from "vitest"
import type { LicenseStatus, TenantLicenseStatus } from "../src/shared/ipc"
import { communityBannerVisible, licenseChipState } from "../src/renderer/lib/license"

vi.mock("../src/renderer/lib/bridge", () => ({ bridge: {} }))

const status: LicenseStatus = {
  hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null,
  plan: null, tenantLimit: null, validUntil: null, communityTenantId: null, tenants: [],
}
const tenant: TenantLicenseStatus = {
  tenantId: "community-tenant", signedIn: true, activated: false, entitled: false,
  source: null, plan: "community", tenants: null, expiresAt: null, validUntil: null,
  shared: null, shareNeedsSignIn: false, displayKey: null, message: null,
}

describe("license chip state", () => {
  it("shows Community without a key, before or after the Community tenant is recorded", () => {
    expect(licenseChipState(status)).toEqual({ label: "Community", tone: "neutral" })
    expect(licenseChipState({ ...status, communityTenantId: tenant.tenantId })).toEqual({ label: "Community", tone: "neutral" })
    expect(licenseChipState({ ...status, tenants: [tenant] })).toEqual({ label: "Community", tone: "neutral" })
  })

  it.each(["pro", "msp"] as const)("shows the %s plan name for an active key", (plan) => {
    expect(licenseChipState({ ...status, hasKey: true, keyState: "active", plan, tenants: [{ ...tenant, activated: true, entitled: true, source: "key", plan }] })).toEqual({ label: plan === "msp" ? "MSP" : "Pro", tone: "neutral" })
  })

  it("shows Organization for a tenant with a shared paid license", () => {
    expect(licenseChipState({ ...status, tenants: [{ ...tenant, entitled: true, activated: true, source: "tenant", plan: "pro" }] })).toEqual({ label: "Organization", tone: "neutral" })
  })

  it("keeps an uncovered signed-in tenant inactive alongside Community and preserves an active plan name", () => {
    const uncovered = { ...tenant, tenantId: "uncovered-tenant", plan: null }
    expect(licenseChipState({ ...status, communityTenantId: tenant.tenantId, tenants: [tenant, uncovered] })).toEqual({ label: "Inactive", tone: "inactive" })
    expect(licenseChipState({ ...status, hasKey: true, keyState: "active", plan: "pro", tenants: [{ ...tenant, activated: true, entitled: true, source: "key", plan: "pro" }, uncovered] })).toEqual({ label: "Pro", tone: "neutral" })
  })

  it("ignores an uncovered tenant that is not signed in", () => {
    expect(licenseChipState({ ...status, tenants: [tenant, { ...tenant, signedIn: false, plan: null }] })).toEqual({ label: "Community", tone: "neutral" })
  })
})

describe("Community banner visibility", () => {
  const day = 24 * 60 * 60 * 1000
  const dismissed = Date.UTC(2026, 9, 12, 12)
  const timestamp = new Date(dismissed).toISOString()

  it("shows the notice when there is no valid dismissal timestamp", () => {
    expect(communityBannerVisible(undefined, dismissed)).toBe(true)
    expect(communityBannerVisible("", dismissed)).toBe(true)
    expect(communityBannerVisible("invalid", dismissed)).toBe(true)
  })

  it("hides the notice throughout the 30 day dismissal period", () => {
    expect(communityBannerVisible(timestamp, dismissed)).toBe(false)
    expect(communityBannerVisible(timestamp, dismissed + 29 * day)).toBe(false)
    expect(communityBannerVisible(timestamp, dismissed + 30 * day - 1)).toBe(false)
  })

  it("shows the notice again at 30 days and afterwards", () => {
    expect(communityBannerVisible(timestamp, dismissed + 30 * day)).toBe(true)
    expect(communityBannerVisible(timestamp, dismissed + 31 * day)).toBe(true)
  })

  it("does not hide the notice indefinitely when the clock moves backwards", () => {
    expect(communityBannerVisible(timestamp, dismissed - day)).toBe(true)
  })
})
