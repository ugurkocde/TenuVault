import { describe, expect, it, vi } from "vitest"
import type { LicenseStatus, TenantLicenseStatus } from "../src/shared/ipc"
import { licenseChipState, licensePageTitle, statusForTenant } from "../src/renderer/lib/license"

vi.mock("../src/renderer/lib/bridge", () => ({ bridge: {} }))

const TRIAL_ENDS = new Date(Date.now() + 13.5 * 86_400_000).toISOString()
const trialTenant: TenantLicenseStatus = {
  tenantId: "trial-tenant", signedIn: true, activated: true, entitled: true, source: "trial", plan: "pro", tenants: 2,
  expiresAt: TRIAL_ENDS, validUntil: TRIAL_ENDS, trial: true, trialEndsAt: TRIAL_ENDS,
  shared: null, shareNeedsSignIn: false, displayKey: null, message: null,
}
const orgTenant: TenantLicenseStatus = {
  tenantId: "org-tenant", signedIn: true, activated: true, entitled: true, source: "tenant", plan: "msp", tenants: 10,
  expiresAt: "2030-01-01T00:00:00.000Z", validUntil: null, trialEndsAt: null,
  shared: null, shareNeedsSignIn: false, displayKey: "****ABCDEF", message: null,
}
// The machine summary the service builds when one tenant runs a trial and another is licensed
// through its organization: the trial is the only entitlement it summarises.
const mixed: LicenseStatus = {
  hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null,
  plan: "pro", tenantLimit: 2, trial: true, trialEndsAt: TRIAL_ENDS, validUntil: null, communityTenantId: null,
  tenants: [trialTenant, orgTenant],
}

describe("license summary for the selected tenant", () => {
  it("shows the organization license, not the other tenant's trial, for an organization-licensed tenant", () => {
    const summary = statusForTenant(mixed, "org-tenant")
    expect(licenseChipState(summary)).toEqual({ label: "Organization", tone: "neutral" })
    expect(licensePageTitle(summary)).toBe("Licensed through your organization")
  })

  it("matches the tenant id case-insensitively", () => {
    expect(licensePageTitle(statusForTenant(mixed, "ORG-TENANT"))).toBe("Licensed through your organization")
  })

  it("keeps the trial for the tenant that runs it", () => {
    const summary = statusForTenant(mixed, "trial-tenant")
    expect(licenseChipState(summary)).toEqual({ label: "Pro trial", tone: "trial", daysLeft: 14 })
    expect(licensePageTitle(summary)).toBe("Pro trial active")
  })

  it("shows the key's plan for a tenant covered by this machine's key while another tenant runs a trial", () => {
    const keyTenant: TenantLicenseStatus = { ...orgTenant, tenantId: "key-tenant", source: "key", plan: "msp", tenants: 10, displayKey: null }
    const summary = statusForTenant({ ...mixed, tenants: [trialTenant, keyTenant] }, "key-tenant")
    expect(licenseChipState(summary)).toEqual({ label: "MSP", tone: "neutral" })
    expect(licensePageTitle(summary)).toBe("MSP plan active")
  })

  it("keeps the machine summary without a selected tenant, or for a tenant that is not signed in, covered or listed", () => {
    expect(statusForTenant(mixed, undefined)).toBe(mixed)
    expect(statusForTenant(mixed, "unknown")).toBe(mixed)
    const signedOut = { ...mixed, tenants: [trialTenant, { ...orgTenant, signedIn: false }] }
    expect(statusForTenant(signedOut, "org-tenant")).toBe(signedOut)
    const lapsed = { ...mixed, tenants: [trialTenant, { ...orgTenant, entitled: false }] }
    expect(statusForTenant(lapsed, "org-tenant")).toBe(lapsed)
    const community = { ...mixed, tenants: [trialTenant, { ...orgTenant, activated: false, source: null, plan: "community" as const }] }
    expect(statusForTenant(community, "org-tenant")).toBe(community)
  })
})
