// The app registration TenuVault Desktop signs in with, as the setup script creates it
// (resources/New-TenuVaultDesktopApp.ps1). Shown in the guided setup before anyone consents.

import { signInErrorRow } from "./sign-in-errors"
import { CONSENT_ROLES, CREATE_BY_HAND } from "./sign-in-words"
import { DEFAULT_SETUP_CHOICE, requestedPermissions, setupScriptArguments, type PermissionChoice } from "./services/manifest"

export const SETUP_SCRIPT_FILE_NAME = "New-TenuVaultDesktopApp.ps1"
export const SETUP_SCRIPT_DOWNLOAD_URL = "https://docs.tenuvault.com/downloads/New-TenuVaultDesktopApp.ps1"
export const APP_REGISTRATION_GUIDE_URL = "https://docs.tenuvault.com/getting-started/app-registration/"
export const MANUAL_APP_REGISTRATION_URL = `${APP_REGISTRATION_GUIDE_URL}#create-the-app-registration-manually`

export { CONSENT_ROLES, CONSENT_ROLES_TEXT, CREATE_BY_HAND } from "./sign-in-words"
export { HANDOFF_SIGN_IN_CODES } from "./sign-in-errors"

export function suggestsCreatingByHand(message: string): boolean {
  return message.toLowerCase().includes(CREATE_BY_HAND)
}

/** What the first sign-in says when the browser did not come back within 15 minutes. */
export const FIRST_SIGN_IN_TIMEOUT_MESSAGE = "The sign-in in the browser was not completed within 15 minutes. Select Try again to sign in again. If Microsoft showed an error in the browser, such as a Conditional Access block, an MFA prompt you could not complete or a request for admin approval, copy the instructions for your admin and send them the setup."

/** Whether a first sign-in error is the 15 minute timeout. */
export function isSignInTimeout(message: string): boolean {
  return message.includes(FIRST_SIGN_IN_TIMEOUT_MESSAGE)
}

/** Whether a first sign-in error names one of the codes the sign-in form offers the handoff for. */
export function offersSignInHandoff(message: string): boolean {
  return (message.match(/AADSTS\d+/g) ?? []).some((code) => signInErrorRow(code)?.handoff === true)
}

const PURPOSE: Record<string, string> = {
  "Microsoft Graph": "Reads the chosen services and groups, and writes only when you restore or deploy.",
  "Azure Service Management": "Lists your storage accounts, only if you keep backups in Azure.",
  "Azure Storage": "Reads and writes backup files, only if you keep backups in Azure.",
}

/** The delegated permissions a setup without choices grants admin consent for, per API, from the permission manifest. */
export const DESKTOP_APP_PERMISSIONS: readonly { api: string; appId: string; permissions: readonly string[]; purpose: string }[] = requestedPermissions(DEFAULT_SETUP_CHOICE, "delegated").map(
  (entry) => ({ ...entry, purpose: PURPOSE[entry.api]! }),
)

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

/**
 * Plain text instructions for the Entra administrator who creates the app registration. With a
 * choice, the command and the permission list are the ones for that choice.
 */
export function setupHandoffText(choice: PermissionChoice = DEFAULT_SETUP_CHOICE): string {
  const permissions = requestedPermissions(choice, "delegated").map((entry) => `  ${entry.api}: ${entry.permissions.join(", ")}`).join("\n")
  return [
    "Could you create the app registration TenuVault Desktop signs in with? It takes a few minutes.",
    "",
    "TenuVault Desktop backs up our chosen Microsoft services from an admin's computer. It signs in",
    "as the admin through a public client app registration in our own tenant: no secret, no certificate and",
    "delegated permissions only, so every call is limited by the admin's own roles, MFA and Conditional Access.",
    "",
    `Who can run it: ${CONSENT_ROLES.join(", ")}.`,
    "",
    `1. Download the setup script: ${SETUP_SCRIPT_DOWNLOAD_URL}`,
    "2. Run it in PowerShell (PowerShell 7 on macOS). It installs nothing:",
    `   ./${SETUP_SCRIPT_FILE_NAME}${setupScriptArguments(choice)}`,
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
