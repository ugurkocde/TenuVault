import { describe, expect, it } from "vitest"
import { namedSignInCode, SIGN_IN_ERRORS, signInErrorLink, signInErrorRow } from "../src/shared/sign-in-errors"

// The error table, row by row: the class and the state of every code, and which of the three
// sign-ins has a text for it. A new row, a moved state or a text for another sign-in fails here
// until this list says the same. The texts themselves are held in sign-in-messages-unchanged.test.ts.
//
// Each row was checked against Microsoft's reference of authentication and authorization error
// codes and against Microsoft's error lookup page (see the header of src/shared/sign-in-errors.ts).
const ROWS: Array<[code: string, errorClass: string, state: string, texts: string]> = [
  ["AADSTS50173", "session", "signInNeeded", ""],
  ["AADSTS700082", "session", "signInNeeded", ""],
  ["AADSTS70008", "session", "signInNeeded", ""],
  ["AADSTS50133", "session", "signInNeeded", ""],
  ["AADSTS50132", "session", "signInNeeded", ""],
  ["AADSTS50089", "session", "signInNeeded", ""],
  ["AADSTS70043", "session", "signInNeeded", ""],
  ["AADSTS70044", "session", "signInNeeded", ""],
  ["AADSTS50055", "session", "signInNeeded", ""],
  ["AADSTS50076", "mfa", "mfaRequired", "firstSignIn"],
  ["AADSTS50079", "mfa", "mfaRequired", "firstSignIn"],
  ["AADSTS50074", "mfa", "mfaRequired", ""],
  ["AADSTS50072", "mfa", "mfaRequired", ""],
  ["AADSTS50078", "mfa", "mfaRequired", ""],
  ["AADSTS50158", "mfa", "mfaRequired", ""],
  ["AADSTS53000", "conditionalAccess", "blockedByConditionalAccess", "firstSignIn setup"],
  ["AADSTS53001", "conditionalAccess", "blockedByConditionalAccess", "firstSignIn setup"],
  ["AADSTS53002", "conditionalAccess", "blockedByConditionalAccess", ""],
  ["AADSTS53003", "conditionalAccess", "blockedByConditionalAccess", "firstSignIn setup reader"],
  ["AADSTS50131", "conditionalAccess", "blockedByConditionalAccess", ""],
  ["AADSTS65001", "consent", "consentMissing", "noConsent setup"],
  ["AADSTS650057", "consent", "consentMissing", "noConsent"],
  ["AADSTS65004", "consent", "consentMissing", "firstSignIn setup"],
  ["AADSTS90094", "consent", "consentMissing", "firstSignIn setup"],
  ["AADSTS700016", "registration", "registrationNotFoundInTenant", "firstSignIn setup reader"],
  ["AADSTS50011", "registration", "registrationMisconfigured", "firstSignIn"],
  ["AADSTS7000218", "registration", "registrationMisconfigured", "firstSignIn"],
  ["AADSTS7000112", "application", "applicationDisabled", "setup reader"],
  ["AADSTS7000229", "application", "servicePrincipalMissing", "reader"],
  ["AADSTS50105", "assignment", "notAssigned", "firstSignIn setup"],
  ["AADSTS50057", "account", "accountDisabled", ""],
  ["AADSTS50053", "account", "accountLockedOrBlocked", ""],
  ["AADSTS50020", "tenant", "wrongTenantOrAccount", "firstSignIn setup"],
  ["AADSTS50034", "tenant", "wrongTenantOrAccount", ""],
  ["AADSTS90072", "tenant", "wrongTenantOrAccount", ""],
  ["AADSTS90002", "tenant", "wrongTenantOrAccount", "firstSignIn setup"],
  ["AADSTS900023", "tenant", "wrongTenantOrAccount", "firstSignIn setup"],
  ["AADSTS50196", "throttled", "throttled", ""],
  ["AADSTS90055", "throttled", "throttled", ""],
  ["AADSTS90033", "unavailable", "unreachable", ""],
  ["AADSTS90006", "unavailable", "unreachable", ""],
  ["AADSTS90090", "unavailable", "unreachable", ""],
  ["AADSTS90024", "unavailable", "unreachable", ""],
  ["AADSTS700027", "credential", "refused", "reader"],
  ["AADSTS7000222", "credential", "refused", "reader"],
  ["AADSTS700024", "credential", "refused", ""],
]

const textsOf = (row: (typeof SIGN_IN_ERRORS)[number]) =>
  [row.firstSignIn ? "firstSignIn" : "", row.noConsent ? "noConsent" : "", row.setup ? "setup" : "", row.reader ? "reader" : ""].filter(Boolean).join(" ")

describe("the sign-in error table", () => {
  it("has exactly the rows listed here, in this order", () => {
    expect(SIGN_IN_ERRORS.map((row) => row.code)).toEqual(ROWS.map(([code]) => code))
  })

  it.each(ROWS)("%s is a %s refusal that leads to %s", (code, errorClass, state, texts) => {
    const row = signInErrorRow(code)!
    expect({ class: row.class, state: row.state, texts: textsOf(row) }).toEqual({ class: errorClass, state, texts })
  })

  it.each(ROWS)("%s links to Microsoft's description of that code", (code) => {
    const row = signInErrorRow(code)!
    expect(row.link).toBe(`https://login.microsoftonline.com/error?code=${code.slice("AADSTS".length)}`)
    expect(row.meaning.length).toBeGreaterThan(10)
  })

  it("has one row per code", () => {
    expect(new Set(SIGN_IN_ERRORS.map((row) => row.code)).size).toBe(SIGN_IN_ERRORS.length)
    for (const row of SIGN_IN_ERRORS) expect(row.code).toMatch(/^AADSTS\d{4,9}$/)
  })

  it("leads every class to one state, apart from the classes that name what is wrong with the registration, the application or the account", () => {
    const states = new Map<string, Set<string>>()
    for (const row of SIGN_IN_ERRORS) states.set(row.class, (states.get(row.class) ?? new Set()).add(row.state))
    const several = [...states].filter(([, found]) => found.size > 1).map(([name]) => name).sort()
    expect(several).toEqual(["account", "application", "registration"])
  })

  // Three codes Microsoft describes more widely than their first rows did (reference and lookup page, checked 2026-11-14).
  it("says no more about a code than Microsoft's description of it proves", () => {
    // One code for a locked account and for a sign-in blocked by its address, on purpose.
    const locked = signInErrorRow("AADSTS50053")!
    expect(locked.state).not.toBe("accountDisabled")
    expect(locked.meaning).toMatch(/locked/)
    expect(locked.meaning).toMatch(/blocked/)
    // Expired client secret keys: it says nothing about a certificate, so no code leads to an expired certificate.
    expect(signInErrorRow("AADSTS7000222")!.meaning).toMatch(/client secret/)
    expect(SIGN_IN_ERRORS.map((row) => row.state as string)).not.toContain("certificateExpired")
    // Not found in the tenant the request went to, which is not the same as deleted.
    const notFound = signInErrorRow("AADSTS700016")!
    expect(notFound.meaning).toMatch(/tenant/)
    expect(notFound.meaning).toMatch(/wrong tenant/)
    expect(`${notFound.state} ${notFound.meaning}`).not.toMatch(/delet|removed/i)
  })

  it("words a code for the setup like a first sign-in only when the first sign-in has a text for it", () => {
    for (const row of SIGN_IN_ERRORS) if (row.setup === "firstSignIn") expect(row.firstSignIn).toBeTruthy()
  })

  it("never uses a dash as punctuation", () => {
    for (const row of SIGN_IN_ERRORS) {
      for (const text of [row.meaning, row.firstSignIn, row.setup, row.reader]) expect(text ?? "").not.toMatch(/[–—]| - /)
    }
  })

  it("has no row for a code it does not know, and still links to Microsoft's description of it", () => {
    expect(signInErrorRow("AADSTS999999")).toBeUndefined()
    expect(signInErrorRow(undefined)).toBeUndefined()
    expect(signInErrorLink("AADSTS999999")).toBe("https://login.microsoftonline.com/error?code=999999")
  })

  it("finds the first code a sign-in error names", () => {
    expect(namedSignInCode("invalid_grant: AADSTS50173: The provided grant has expired. Trace ID: x")).toBe("AADSTS50173")
    expect(namedSignInCode("network down")).toBeUndefined()
  })
})
