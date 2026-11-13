import { describe, expect, it } from "vitest"
import { Preferences } from "../src/main/preferences"
import { ORGANIZATION_LICENSE_MESSAGE, TRIAL_USED_MESSAGE } from "../src/shared/constants"
import type { LicenseStatus, TenantLicenseStatus } from "../src/shared/ipc"
import { trialOfferEligible, trialOfferRefusal } from "../src/renderer/lib/trial-offer"
import { memoryStore } from "./helpers"

const id = "11111111-2222-4333-8444-555555555555"
const other = "66666666-7777-4888-9999-000000000000"

function community(overrides: Partial<TenantLicenseStatus> = {}): TenantLicenseStatus {
  return { tenantId: id, signedIn: true, activated: false, entitled: false, source: null, plan: "community", tenants: null, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null, trialEndsAt: null, ...overrides }
}
function status(tenant: TenantLicenseStatus = community(), overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return { hasKey: false, keyState: "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: null, tenantLimit: null, validUntil: null, communityTenantId: id, tenants: [tenant], tenantTrialsEnabled: true, ...overrides }
}

describe("trial card eligibility", () => {
  it("offers the trial to a signed-in Community tenant that never had one", () => {
    expect(trialOfferEligible(status(), id, [])).toBe(true)
    // The tenant ID from a saved profile may be upper case.
    expect(trialOfferEligible(status(), id.toUpperCase(), [])).toBe(true)
  })

  it.each<[string, LicenseStatus | null]>([
    ["no license status yet", null],
    ["a license key on this machine", status(community(), { hasKey: true })],
    ["tenant trials disabled", status(community(), { tenantTrialsEnabled: false })],
    ["tenant trials unknown", status(community(), { tenantTrialsEnabled: undefined })],
    ["no trials left on this installation", status(community(), { tenantTrialInstallLimit: true })],
    ["a tenant missing from the status", status(community({ tenantId: other }))],
    ["a tenant without a sign-in", status(community({ signedIn: false }))],
    ["a tenant not on Community", status(community({ plan: null }))],
    ["Pro", status(community({ plan: "pro", entitled: true, activated: true, source: "key" }))],
    ["MSP", status(community({ plan: "msp", entitled: true, activated: true, source: "key" }))],
    ["an organization license", status(community({ plan: "pro", entitled: true, activated: true, source: "tenant" }))],
    ["a saved activation", status(community({ activated: true }))],
    ["a running trial", status(community({ plan: "pro", entitled: true, activated: true, source: "trial", trial: true, trialEndsAt: "2026-11-27T00:00:00.000Z" }))],
    ["an ended trial", status(community({ trialEndsAt: "2026-11-01T00:00:00.000Z" }))],
    ["a trial ended early that can be resumed", status(community({ trialCanResume: true, trialResumeUntil: "2026-11-27T00:00:00.000Z" }))],
    ["a refusal by the trial service", status(community({ trialRefusal: "This tenant already had a Pro trial." }))],
    ["an organization license this sign-in cannot use", status(community({ trialRefusal: ORGANIZATION_LICENSE_MESSAGE }))],
    ["a trial used on another installation", status(community({ message: TRIAL_USED_MESSAGE }))],
  ])("is not shown for %s", (_case, value) => {
    expect(trialOfferEligible(value, id, [])).toBe(false)
  })

  it("is not shown for a tenant dismissed or refused before, and still for other tenants", () => {
    const two = status(community(), { tenants: [community(), community({ tenantId: other })] })
    expect(trialOfferEligible(two, id, [id])).toBe(false)
    expect(trialOfferEligible(two, other, [id])).toBe(true)
  })

  it("treats a refusal saved with the tenant as final and anything else as retryable", () => {
    expect(trialOfferRefusal(status(community({ trialRefusal: "This installation has already started its available tenant trials." })), id)).toBe("This installation has already started its available tenant trials.")
    expect(trialOfferRefusal(status(community({ message: TRIAL_USED_MESSAGE })), id)).toBe(TRIAL_USED_MESSAGE)
    expect(trialOfferRefusal(status(), id)).toBeNull()
    expect(trialOfferRefusal(null, id)).toBeNull()
  })
})

describe("trial card dismissal preference", () => {
  it("persists hidden tenants across instances and unrelated changes", () => {
    const store = memoryStore()
    expect(new Preferences(store).get().trialOfferHiddenTenantIds).toBeUndefined()
    new Preferences(store).set({ trialOfferHiddenTenantIds: [id] })
    new Preferences(store).set({ retentionDays: 90 })
    expect(new Preferences(store).get()).toMatchObject({ trialOfferHiddenTenantIds: [id], retentionDays: 90 })
  })

  it.each<[string, unknown]>([["null", null], ["a string", "id"], ["a number", [123]], ["a non-GUID", ["not-a-tenant"]], ["upper case", ["AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"]], ["an object", {}], ["over 1000 tenants", Array(1001).fill(id)]])("rejects %s without changing the stored list", (_case, value) => {
    const preferences = new Preferences(memoryStore())
    preferences.set({ trialOfferHiddenTenantIds: [id] })
    expect(() => preferences.set({ trialOfferHiddenTenantIds: value } as never)).toThrow("Invalid value for trialOfferHiddenTenantIds.")
    expect(preferences.get().trialOfferHiddenTenantIds).toEqual([id])
  })

  it("ignores a malformed stored list and keeps other preferences", () => {
    const store = memoryStore()
    store.set("app.preferences", JSON.stringify({ trialOfferHiddenTenantIds: "x", retentionDays: 90 }))
    expect(new Preferences(store).get().trialOfferHiddenTenantIds).toBeUndefined()
    expect(new Preferences(store).get().retentionDays).toBe(90)
  })
})
