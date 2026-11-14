import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { setupSignInError } from "../src/main/auth/app-registration-setup"
import { BackupReaderService, type AcquireToken } from "../src/main/auth/backup-reader"
import { firstSignInError, missingPermissionError } from "../src/main/auth/msal"
import { SecureStore } from "../src/main/storage/secure-store"
import { RESOURCE_SCOPES } from "../src/shared/constants"

// The texts a first sign-in, the setup and the Backup Reader showed for each Microsoft error code
// before they were read from one table, written out in full. A change to the table that alters a
// message an admin sees fails here, word for word.

const ROLES = "Global Administrator, Cloud Application Administrator or Application Administrator"
const TOOLS = "Microsoft Graph Command Line Tools, the Microsoft app that the setup and the setup script sign in through"

const FIRST_SIGN_IN: Record<string, string> = {
  AADSTS700016: "No app registration with this client ID exists in this tenant. Check the Application (client) id, and that the tenant is the one the app registration was created in. If it was created a moment ago, wait a minute and sign in again.",
  AADSTS90002: "Microsoft does not know this tenant. Check the tenant ID or domain, for example contoso.onmicrosoft.com.",
  AADSTS900023: "This is not a valid tenant ID or domain. Use the tenant ID of your tenant, or a domain such as contoso.onmicrosoft.com.",
  AADSTS50011: "The app registration has no http://localhost redirect URI for mobile and desktop applications. Run the setup script again, or add the redirect URI as the setup guide describes.",
  AADSTS7000218: "The app registration asks for a client secret, which happens when http://localhost is registered for the Web platform. In the Entra admin center, open the app registration > Authentication and add http://localhost under Mobile and desktop applications instead, or run the setup script again.",
  AADSTS50020: "This account does not belong to the tenant. Sign in with an admin account of this tenant.",
  AADSTS50105: "Your account is not assigned to the TenuVault app registration. Ask your Entra administrator to add you to the group that may sign in.",
  AADSTS53000: "Conditional Access requires a compliant or registered device. Use a browser that passes the device identity, such as Microsoft Edge signed in to your work profile, as the default browser and try again.",
  AADSTS53001: "Conditional Access requires a domain-joined device. Use a browser that passes the device identity, such as Microsoft Edge signed in to your work profile, as the default browser and try again.",
  AADSTS53003: "Conditional Access blocked this sign-in. Check the sign-in logs in the Entra admin center for the policy, or sign in from a device and location it allows.",
  AADSTS50076: "Microsoft asks for multifactor authentication for this sign-in, because of a Conditional Access policy, per-user MFA or a new location, and it was not completed. Sign in again and complete the MFA prompt in the browser. If no prompt appears, ask your Entra administrator to check the sign-in logs in the Entra admin center.",
  AADSTS50079: "Microsoft requires multifactor authentication for this sign-in, because of a Conditional Access policy, per-user MFA or a new location, and your account cannot complete it yet. If your account is managed in Entra ID, register your security info at https://mysignins.microsoft.com/security-info and sign in again. If your account signs in through another identity provider (a federated account), that provider must supply the MFA claim: ask your administrator to set it up.",
  AADSTS90094: `Administrator consent is required: this tenant does not let your account grant the permissions the TenuVault app registration asks for. Ask a ${ROLES} to grant admin consent for it, or send them the setup instructions.`,
  AADSTS65004: "The consent was declined in the browser. Sign in again and accept, or ask an administrator to run the setup script, which grants admin consent.",
}

const NO_CONSENT = (code: string) => `The app registration has no admin consent for Microsoft Graph (${code}). Add the Microsoft Graph permissions listed in the setup guide to the app registration, grant admin consent, and sign in again.`

/** What the setup shows for a code, before "Nothing was changed." */
const SETUP: Record<string, string> = {
  AADSTS65004: `You declined Microsoft's request to approve Microsoft Graph Command Line Tools (AADSTS65004). Select Try again and accept it, or use "Someone else is the admin?".`,
  AADSTS65001: `Microsoft did not let this account approve the setup (AADSTS65001). Sign in with a ${ROLES}, or use "Someone else is the admin?".`,
  AADSTS90094: `Microsoft did not let this account approve the setup (AADSTS90094). Sign in with a ${ROLES}, or use "Someone else is the admin?".`,
  AADSTS700016: `This tenant does not let your account sign in to ${TOOLS} (AADSTS700016). Ask your Entra administrator to allow it for your account, or create the app registration by hand in the Entra admin center.`,
  AADSTS7000112: `This tenant does not let your account sign in to ${TOOLS} (AADSTS7000112). Ask your Entra administrator to allow it for your account, or create the app registration by hand in the Entra admin center.`,
  AADSTS50105: `This tenant does not let your account sign in to ${TOOLS} (AADSTS50105). Ask your Entra administrator to allow it for your account, or create the app registration by hand in the Entra admin center.`,
  AADSTS53003: `Conditional Access blocked the sign-in to ${TOOLS} (AADSTS53003). Check the sign-in logs in the Entra admin center for the policy that applied. If it asks for a compliant device or an allowed location, sign in from one and select Try again. If it blocks Microsoft Graph Command Line Tools, create the app registration by hand in the Entra admin center.`,
  // The setup words these like a first sign-in does.
  AADSTS90002: `${FIRST_SIGN_IN.AADSTS90002} (AADSTS90002)`,
  AADSTS900023: `${FIRST_SIGN_IN.AADSTS900023} (AADSTS900023)`,
  AADSTS50020: `${FIRST_SIGN_IN.AADSTS50020} (AADSTS50020)`,
  AADSTS53000: `${FIRST_SIGN_IN.AADSTS53000} (AADSTS53000)`,
  AADSTS53001: `${FIRST_SIGN_IN.AADSTS53001} (AADSTS53001)`,
}

/** What the Backup Reader adds after "Microsoft refused the Backup Reader (code)." for a refusal no retry can fix. */
const READER: Record<string, string> = {
  AADSTS700027: "Microsoft does not know this certificate. Upload the exported certificate with the setup script, then verify again.",
  AADSTS7000222: "The certificate has expired. Create a renewal certificate in Settings and upload it.",
  AADSTS700016: "No app registration with this application ID exists in the tenant.",
  AADSTS7000112: "The Backup Reader app registration is disabled.",
  AADSTS7000229: "The Backup Reader app registration has no service principal in the tenant. Run the setup script again.",
  AADSTS53003: "Conditional Access for workload identities blocked the Backup Reader from this location.",
}
const READER_RETRY = "Try again in a few minutes, then check the app registration and its certificate."

const refusal = (code: string) => new Error(`${code}: what Microsoft said. Trace ID: abc`)

describe("first sign-in", () => {
  it.each(Object.entries(FIRST_SIGN_IN))("says the same as before for %s", (code, text) => {
    expect((firstSignInError(refusal(code)) as Error).message).toBe(`${text} (${code})`)
  })

  it.each(["AADSTS65001", "AADSTS650057"])("says the same as before for %s", (code) => {
    expect((firstSignInError(refusal(code)) as Error).message).toBe(NO_CONSENT(code))
  })

  it("leaves a code it has no text for as Microsoft worded it", () => {
    const error = refusal("AADSTS50173")
    expect(firstSignInError(error)).toBe(error)
  })
})

describe("signing in again", () => {
  it.each(["AADSTS65001", "AADSTS650057"])("names the missing consent for %s as before", (code) => {
    expect(missingPermissionError(RESOURCE_SCOPES.graph, refusal(code))?.message).toBe(NO_CONSENT(code))
    expect(missingPermissionError(RESOURCE_SCOPES.storage, refusal(code))?.message).toBe(
      `The app registration has no admin consent for Azure Storage (${code}). Add the Azure Storage user_impersonation permission to the app registration, grant admin consent, and sign in again.`,
    )
  })

  it.each(["AADSTS90094", "AADSTS65004", "AADSTS50076", "AADSTS700016"])("has no such text for %s", (code) => {
    expect(missingPermissionError(RESOURCE_SCOPES.graph, refusal(code))).toBeNull()
  })
})

describe("setup", () => {
  it.each(Object.entries(SETUP))("says the same as before for %s", (code, text) => {
    expect((setupSignInError(refusal(code)) as Error).message).toBe(`${text} Nothing was changed.`)
  })

  it.each(["AADSTS50011", "AADSTS7000218", "AADSTS50076", "AADSTS50079", "AADSTS650057", "AADSTS50173"])("shows Microsoft's own words for %s", (code) => {
    expect((setupSignInError(refusal(code)) as Error).message).toBe(`${code}: what Microsoft said. Trace ID: abc Nothing was changed.`)
  })
})

describe("Backup Reader", () => {
  const TENANT = "11111111-1111-1111-1111-111111111111"
  const READER_ID = "44444444-4444-4444-4444-444444444444"
  const ROLES_HELD = ["DeviceManagementApps.Read.All", "DeviceManagementConfiguration.Read.All", "DeviceManagementRBAC.Read.All", "DeviceManagementScripts.Read.All", "DeviceManagementServiceConfig.Read.All"]
  const cipher = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString("utf8") }
  const token = `e30.${Buffer.from(JSON.stringify({ aud: "https://graph.microsoft.com", tid: TENANT, appid: READER_ID, idtyp: "app", roles: ROLES_HELD })).toString("base64url")}.sig`

  function reader() {
    let answer: () => string = () => token
    const acquire: AcquireToken = async () => ({ accessToken: answer() })
    const service = new BackupReaderService(new SecureStore(join(mkdtempSync(join(tmpdir(), "tv-messages-")), "store.enc"), cipher), { acquire, now: () => new Date("2026-11-14T12:00:00Z") })
    service.prepare(TENANT, "PC")
    return { service, refuse: (code: string) => { answer = () => { throw refusal(code) } } }
  }
  const scheduled = { tenantId: TENANT, clientId: "22222222-2222-2222-2222-222222222222", storageAccountName: "contoso", trigger: "scheduled" as const }

  it.each(Object.entries(READER))("says the same as before when a verification is refused with %s", async (code, text) => {
    const { service, refuse } = reader()
    refuse(code)
    await expect(service.verify(TENANT, READER_ID)).rejects.toHaveProperty("message", `Microsoft refused the Backup Reader (${code}). ${text}`)
  })

  it.each(["AADSTS90033", "AADSTS700024", "AADSTS50173"])("asks to try again when a verification is refused with %s", async (code) => {
    const { service, refuse } = reader()
    refuse(code)
    await expect(service.verify(TENANT, READER_ID)).rejects.toHaveProperty("message", `Microsoft refused the Backup Reader (${code}). ${READER_RETRY}`)
  })

  it.each(Object.entries(READER))("ends a scheduled backup with the same text for %s", async (code, text) => {
    const { service, refuse } = reader()
    await service.verify(TENANT, READER_ID)
    refuse(code)
    await expect(service.tokens(scheduled)!.graph()).rejects.toHaveProperty("message", `Microsoft refused the Backup Reader (${code}). ${text}`)
  })

  it.each(["AADSTS90033", "AADSTS700024", "AADSTS50173"])("leaves %s to be retried by a scheduled backup, as Microsoft worded it", async (code) => {
    const { service, refuse } = reader()
    await service.verify(TENANT, READER_ID)
    refuse(code)
    await expect(service.tokens(scheduled)!.graph()).rejects.toHaveProperty("message", `${code}: what Microsoft said. Trace ID: abc`)
  })
})
