import { describe, expect, it } from "vitest"
import { isResourceScope, missingPermissionError, signInAgainMessage } from "../src/main/auth/msal"
import { RESOURCE_SCOPES } from "../src/shared/constants"

describe("signInAgainMessage", () => {
  it("names the resource and the AADSTS code of a refused silent request", () => {
    const message = signInAgainMessage("admin@contoso.com", RESOURCE_SCOPES.storage, {
      errorCode: "invalid_grant",
      errorMessage: "AADSTS65001: The user or administrator has not consented to use the application.",
    })
    expect(message).toBe("Microsoft needs you to sign in again as admin@contoso.com for Azure Storage (invalid_grant, AADSTS65001).")
  })

  it("leaves out what Microsoft did not return", () => {
    expect(signInAgainMessage("admin@contoso.com", "https://example.com/.default", {})).toBe("Microsoft needs you to sign in again as admin@contoso.com.")
  })
})

describe("isResourceScope", () => {
  it("accepts only the scopes TenuVault signs in for", () => {
    expect(Object.values(RESOURCE_SCOPES).every(isResourceScope)).toBe(true)
    expect(isResourceScope("https://example.com/.default")).toBe(false)
    expect(isResourceScope(undefined)).toBe(false)
    for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(isResourceScope(inherited)).toBe(false)
  })
})

describe("missingPermissionError", () => {
  it("explains a missing permission or consent that signing in again cannot fix", () => {
    // Message shape observed from Entra for an app registration without Azure Storage.
    const error = new Error("invalid_client: AADSTS650057: Invalid resource. The client has requested access to a resource which is not listed in the requested permissions in the client's application registration.")
    expect(missingPermissionError(RESOURCE_SCOPES.storage, error)?.message).toBe(
      "The app registration has no admin consent for Azure Storage (AADSTS650057). Add the Azure Storage user_impersonation permission to the app registration, grant admin consent, and sign in again.",
    )
    expect(missingPermissionError(RESOURCE_SCOPES.management, new Error("AADSTS65001: not consented"))?.message).toContain("Azure Service Management (AADSTS65001)")
  })

  it("leaves other sign-in errors alone", () => {
    expect(missingPermissionError(RESOURCE_SCOPES.storage, new Error("AADSTS50076: MFA required"))).toBeNull()
    expect(missingPermissionError(RESOURCE_SCOPES.storage, new Error("AADSTS6500571: other"))).toBeNull()
  })
})
