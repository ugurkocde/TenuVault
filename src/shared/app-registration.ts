// The app registration TenuVault Desktop signs in with, as the setup script creates it
// (resources/New-TenuVaultDesktopApp.ps1). Shown in the guided setup before anyone consents.

export const SETUP_SCRIPT_FILE_NAME = "New-TenuVaultDesktopApp.ps1"
export const SETUP_SCRIPT_DOWNLOAD_URL = "https://docs.tenuvault.com/downloads/New-TenuVaultDesktopApp.ps1"
export const APP_REGISTRATION_GUIDE_URL = "https://docs.tenuvault.com/getting-started/app-registration/"
export const MANUAL_APP_REGISTRATION_URL = `${APP_REGISTRATION_GUIDE_URL}#create-the-app-registration-manually`

/** The Entra roles that can run the setup script, because they can grant tenant-wide admin consent. */
export const CONSENT_ROLES = ["Global Administrator", "Privileged Role Administrator", "Cloud Application Administrator"] as const

/** The delegated permissions the setup script grants admin consent for by default, per API. */
export const DESKTOP_APP_PERMISSIONS: readonly { api: string; permissions: readonly string[]; purpose: string }[] = [
  {
    api: "Microsoft Graph",
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
    permissions: ["user_impersonation"],
    purpose: "Lists your storage accounts, only if you keep backups in Azure.",
  },
  {
    api: "Azure Storage",
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
    "2. Run it in PowerShell (PowerShell 7 on macOS):",
    `   ./${SETUP_SCRIPT_FILE_NAME}`,
    "   To limit sign-in to a group of admins, add: -AllowedGroupId <group object id>",
    "3. Sign in when Microsoft Graph PowerShell asks you to.",
    "4. Send me the two lines it prints at the end: the Tenant id and the Application (client) id.",
    "",
    "It grants tenant-wide admin consent for these delegated permissions:",
    permissions,
    "",
    `Guide, including how to create it by hand in the Entra admin center: ${APP_REGISTRATION_GUIDE_URL}`,
  ].join("\n")
}
