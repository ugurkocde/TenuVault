import { describe, expect, it } from "vitest"
import { sameLicense } from "../src/main/license/same-license"

const A = "11111111-1111-1111-1111-111111111111"
const B = "22222222-2222-2222-2222-222222222222"

type Entry = { tenantId: string; entitled: boolean; source: "key" | "tenant" | "trial" | null; displayKey: string | null }
const tenant = (tenantId: string, source: Entry["source"], options: Partial<Entry> = {}): Entry => ({ tenantId, entitled: true, source, displayKey: null, ...options })

describe("sameLicense", () => {
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
