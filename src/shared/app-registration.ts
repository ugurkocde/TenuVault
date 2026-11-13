// The app registration TenuVault Desktop signs in with, as the setup script creates it
// (resources/New-TenuVaultDesktopApp.ps1). Shown in the guided setup before anyone consents.

export const SETUP_SCRIPT_FILE_NAME = "New-TenuVaultDesktopApp.ps1"
export const SETUP_SCRIPT_DOWNLOAD_URL = "https://docs.tenuvault.com/downloads/New-TenuVaultDesktopApp.ps1"
export const APP_REGISTRATION_GUIDE_URL = "https://docs.tenuvault.com/getting-started/app-registration/"
export const MANUAL_APP_REGISTRATION_URL = `${APP_REGISTRATION_GUIDE_URL}#create-the-app-registration-manually`

/**
 * The Entra roles that can run the setup: each can both create the app registration and grant
 * tenant-wide admin consent for delegated permissions. A Privileged Role Administrator can grant
 * the consent, but creates an app registration only where every user may, so it is not listed.
 */
export const CONSENT_ROLES = ["Global Administrator", "Cloud Application Administrator", "Application Administrator"] as const
/** The roles in a sentence: "A, B or C". */
export const CONSENT_ROLES_TEXT = `${CONSENT_ROLES.slice(0, -1).join(", ")} or ${CONSENT_ROLES.at(-1)}`

/**
 * The route that works when the tenant blocks Microsoft Graph Command Line Tools, which the setup
 * and the setup script both sign in through. Setup errors that need it say these words, and the
 * Connect step then offers the manual guide next to the error.
 */
export const CREATE_BY_HAND = "create the app registration by hand"
export function suggestsCreatingByHand(message: string): boolean {
  return message.toLowerCase().includes(CREATE_BY_HAND)
}

/** What the first sign-in says when the browser did not come back within 15 minutes. */
export const FIRST_SIGN_IN_TIMEOUT_MESSAGE = "The sign-in in the browser was not completed within 15 minutes. Select Try again to sign in again. If Microsoft showed an error in the browser, such as a Conditional Access block, an MFA prompt you could not complete or a request for admin approval, copy the instructions for your admin and send them the setup."

/** Whether a first sign-in error is the 15 minute timeout. */
export function isSignInTimeout(message: string): boolean {
  return message.includes(FIRST_SIGN_IN_TIMEOUT_MESSAGE)
}

/**
 * The first sign-in refusals another administrator or the manual setup can get around: Conditional
 * Access (53000, 53001, 53003), missing consent or approval (65001, 90094) and MFA (50076, 50079).
 */
export const HANDOFF_SIGN_IN_CODES: readonly string[] = ["AADSTS53000", "AADSTS53001", "AADSTS53003", "AADSTS65001", "AADSTS90094", "AADSTS50076", "AADSTS50079"]

/** Whether a first sign-in error names one of the codes the sign-in form offers the handoff for. */
export function offersSignInHandoff(message: string): boolean {
  return (message.match(/AADSTS\d+/g) ?? []).some((code) => HANDOFF_SIGN_IN_CODES.includes(code))
}

/** The delegated permissions the setup script grants admin consent for by default, per API. */
export const DESKTOP_APP_PERMISSIONS: readonly { api: string; appId: string; permissions: readonly string[]; purpose: string }[] = [
  {
    api: "Microsoft Graph",
    appId: "00000003-0000-0000-c000-000000000000",
    permissions: [
      "User.Read",
      "Organization.Read.All",
      "Policy.Read.All",
      "DeviceManagementConfiguration.ReadWrite.All",
      "DeviceManagementApps.ReadWrite.All",
      "DeviceManagementServiceConfig.ReadWrite.All",
      "DeviceManagementScripts.ReadWrite.All",
      "DeviceManagementRBAC.ReadWrite.All",
      "DeviceManagementManagedDevices.Read.All",
    ],
    purpose: "Reads Intune configuration for backups, and writes it only when you restore or deploy.",
  },
  {
    api: "Azure Service Management",
    appId: "797f4846-ba00-4fd7-ba43-dac1f8f63013",
    permissions: ["user_impersonation"],
    purpose: "Lists your storage accounts, only if you keep backups in Azure.",
  },
  {
    api: "Azure Storage",
    appId: "e406a681-f3d4-42a8-90b6-c2b029497af1",
    permissions: ["user_impersonation"],
    purpose: "Reads and writes backup files, only if you keep backups in Azure.",
  },
]

const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/**
 * The tenant ID and client ID from the setup script's closing lines, pasted in one go. Either is
 * undefined when the text does not contain it. Labels are matched loosely, so a copy of the
 * console output with extra spaces, tabs or a prompt still works.
 */
export function parseSetupOutput(text: string): { tenantId?: string; clientId?: string } {
  const tenant = new RegExp(`tenant\\s*id\\s*:\\s*(${GUID})`, "i").exec(text)?.[1]
  const client = new RegExp(`(?:application\\s*\\(client\\)\\s*id|client\\s*id)\\s*:\\s*(${GUID})`, "i").exec(text)?.[1]
  return {
    ...(tenant ? { tenantId: tenant.toLowerCase() } : {}),
    ...(client ? { clientId: client.toLowerCase() } : {}),
  }
}

/** Plain text instructions for the Entra administrator who creates the app registration. */
export function setupHandoffText(): string {
  const permissions = DESKTOP_APP_PERMISSIONS.map((entry) => `  ${entry.api}: ${entry.permissions.join(", ")}`).join("\n")
  return [
    "Could you create the app registration TenuVault Desktop signs in with? It takes a few minutes.",
    "",
    "TenuVault Desktop backs up and restores our Intune configuration from an admin's computer. It signs in",
    "as the admin through a public client app registration in our own tenant: no secret, no certificate and",
    "delegated permissions only, so every call is limited by the admin's own roles, MFA and Conditional Access.",
    "",
    `Who can run it: ${CONSENT_ROLES.join(", ")}.`,
    "",
    `1. Download the setup script: ${SETUP_SCRIPT_DOWNLOAD_URL}`,
    "2. Run it in PowerShell (PowerShell 7 on macOS). It installs nothing:",
    `   ./${SETUP_SCRIPT_FILE_NAME}`,
    "   To limit sign-in to a group of admins, add: -AllowedGroupId <group object id>",
    "3. Sign in with your admin account in the browser window it opens. Microsoft may first ask you to consent to",
    "   Microsoft Graph Command Line Tools, which the script signs in through to create the app registration.",
    "4. Send me the two lines it prints at the end: the Tenant id and the Application (client) id.",
    "   The script also copies them to your clipboard.",
    "",
    "If our tenant blocks Microsoft Graph Command Line Tools for your account (for example AADSTS7000112,",
    "AADSTS50105 or a Conditional Access policy that blocks the app), the script cannot sign in. Create the app registration by hand",
    `in the Entra admin center instead and send me the same two IDs: ${MANUAL_APP_REGISTRATION_URL}`,
    "",
    "It grants tenant-wide admin consent for these delegated permissions:",
    permissions,
    "",
    `Guide, including how to create it by hand in the Entra admin center: ${APP_REGISTRATION_GUIDE_URL}`,
  ].join("\n")
}

/**
 * The two IDs the setup script copied to the clipboard, or null. Both must be present, so other
 * clipboard content never reaches the renderer.
 */
export function setupIdsFromClipboard(text: unknown): { tenantId: string; clientId: string } | null {
  if (typeof text !== "string" || text.length > 4000) return null
  const { tenantId, clientId } = parseSetupOutput(text)
  return tenantId && clientId ? { tenantId, clientId } : null
}
