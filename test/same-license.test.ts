import { describe, expect, it } from "vitest"
import { proPair, sameLicense } from "../src/main/license/same-license"
import type { TenantLicenseStatus } from "../src/shared/ipc"

const A = "aaaaaaaa-1111-1111-1111-111111111111"
const B = "bbbbbbbb-2222-2222-2222-222222222222"

type Entry = Pick<TenantLicenseStatus, "tenantId" | "entitled" | "source" | "displayKey" | "plan">
const tenant = (tenantId: string, source: Entry["source"], options: Partial<Entry> = {}): Entry => ({ tenantId, entitled: true, source, displayKey: null, plan: "pro", ...options })

describe("proPair for single-target Copy to Tenants and Dev to Prod", () => {
  it.each([
    ["key", "trial"],
    ["key", "tenant"],
    ["trial", "trial"],
  ] as const)("pairs a %s tenant with a %s tenant", (first, second) => {
    expect(proPair([tenant(A, first), tenant(B, second)], A, B)).toBe(true)
  })

  it("pairs Pro and MSP in either direction", () => {
    const tenants = [tenant(A, "trial"), tenant(B, "tenant", { plan: "msp" })]
    expect(proPair(tenants, A, B)).toBe(true)
    expect(proPair(tenants, B, A)).toBe(true)
  })

  it("requires entitlement and a paid plan on both tenants", () => {
    expect(proPair([tenant(A, "key"), tenant(B, "trial", { entitled: false })], A, B)).toBe(false)
    expect(proPair([tenant(A, null, { plan: "community" }), tenant(B, "key")], A, B)).toBe(false)
    expect(proPair([tenant(A, "key")], A, B)).toBe(false)
  })

  it("matches tenant IDs case-insensitively", () => {
    expect(proPair([tenant(A, "key"), tenant(B.toUpperCase(), "trial")], A.toUpperCase(), B)).toBe(true)
  })
})

describe("sameLicense for Pro custom baseline deployment", () => {
  it("pairs two tenants of this machine's key", () => {
    expect(sameLicense([tenant(A, "key"), tenant(B, "key")], A, B)).toBe(true)
  })

  it("pairs two tenants of the same organization license and not of different ones", () => {
    expect(sameLicense([tenant(A, "tenant", { displayKey: "****ABCDEF" }), tenant(B, "tenant", { displayKey: "****ABCDEF" })], A, B)).toBe(true)
    expect(sameLicense([tenant(A, "tenant", { displayKey: "****ABCDEF" }), tenant(B, "tenant", { displayKey: "****123456" })], A, B)).toBe(false)
    expect(sameLicense([tenant(A, "tenant"), tenant(B, "tenant")], A, B)).toBe(false)
  })

  it("pairs two tenants that each run a Pro trial", () => {
    expect(sameLicense([tenant(A, "trial"), tenant(B, "trial")], A, B)).toBe(true)
  })

  it("does not pair a trial with a key or an organization license", () => {
    expect(sameLicense([tenant(A, "trial"), tenant(B, "key")], A, B)).toBe(false)
    expect(sameLicense([tenant(A, "trial"), tenant(B, "tenant", { displayKey: "****ABCDEF" })], A, B)).toBe(false)
  })

  it("does not pair a tenant whose trial or license is no longer entitled", () => {
    expect(sameLicense([tenant(A, "trial"), tenant(B, "trial", { entitled: false })], A, B)).toBe(false)
    expect(sameLicense([tenant(A, "key", { entitled: false }), tenant(B, "key")], A, B)).toBe(false)
  })

  it("does not pair a tenant without a license status and matches IDs case-insensitively", () => {
    expect(sameLicense([tenant(A, "trial")], A, B)).toBe(false)
    expect(sameLicense([tenant(A, "trial"), tenant(B, "trial")], A.toUpperCase(), B.toUpperCase())).toBe(true)
  })
})
