import type { BackupReaderState } from "../../shared/ipc"
import { typeForFolder } from "../../shared/intune/registry"

export const READER_GUIDE_URL = "https://docs.tenuvault.com/backups/backup-reader/"
export const READER_CA_GUIDE_URL = "https://docs.tenuvault.com/security/conditional-access/"

/** Days before expiry from which the Backup Reader card asks for a renewal. */
export const RENEW_DAYS = 30

/** What the Backup Reader card shows for a tenant's state. */
export function readerView(state: BackupReaderState | null, now = Date.now()) {
  const reader = state?.reader ?? null
  const verified = reader?.state === "verified"
  // A renewal waits next to the verified certificate, so both the status and the steps show.
  const waiting = !!reader && (reader.state === "pending" || reader.renewalPending)
  const daysLeft = reader ? Math.ceil((Date.parse(reader.notAfter) - now) / 86_400_000) : null
  // A waiting renewal does not silence the warning: until it is uploaded and verified, the old certificate still expires.
  const expiry = verified && daysLeft !== null && daysLeft <= RENEW_DAYS ? (daysLeft > 0 ? "soon" as const : "expired" as const) : null
  // A renewal or another computer's certificate goes onto the same app registration. The script sets
  // exactly the permissions it is given, so a reader with the device inventory permission keeps it.
  const inventory = reader?.verifiedRoles?.includes("DeviceManagementManagedDevices.Read.All") ? " -IncludeDeviceCategories" : ""
  const command = verified
    ? `./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer> -AppId ${reader.clientId}${inventory}`
    : "./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer>"
  const excluded = (reader?.excludedTypes ?? []).map((folder) => typeForFolder(folder)?.label ?? folder)
  return { reader, verified, waiting, daysLeft, expiry, command, excluded, storageAccountName: state?.storageAccountName, canAct: !!state?.supported && !!state.available }
}

/** The storage command an Azure administrator runs for the reader; values the app cannot know stay placeholders. */
export function readerStorageCommand(storageAccountName: string | undefined, clientId: string): string {
  return `./New-TenuVaultStorage.ps1 -AdminGroupId <Intune admin group object ID> -SubscriptionId <subscription ID> -ResourceGroupName <resource group> -StorageAccountName ${storageAccountName ?? "<storage account>"} -BackupReaderAppId ${clientId || "<application ID from the setup script>"}`
}

/** A ready-to-send request for the Entra administrator, so the handoff does not start from a blank message. */
export function readerEntraRequest(command: string, renewal: boolean): string {
  return [
    renewal
      ? "Please upload the renewal certificate for the TenuVault Backup Reader app registration."
      : "Please create the TenuVault Backup Reader app registration for scheduled Intune backups.",
    "The attached .cer file is a public certificate only; the private key stays on my computer.",
    `Run: ${command} (add -IncludeDeviceCategories only if we agreed on it).`,
    "The script creates a single-tenant app registration with exactly five read-only Graph application permissions, uploads the certificate, removes any other permission on that app, and grants admin consent.",
    `Details and the permission list: ${READER_GUIDE_URL}`,
    "Please send me the application (client) ID and certificate thumbprint it prints.",
  ].join("\n")
}

/** A ready-to-send request for the Azure administrator who grants the write-without-delete storage role. */
export function readerAzureRequest(storageCommand: string, storageAccountName: string | undefined): string {
  return [
    `Please let the TenuVault Backup Reader write backups to ${storageAccountName ? `storage account ${storageAccountName}` : "our backup storage"}, without delete access.`,
    `Run: ${storageCommand}`,
    "It creates the intune-backups container, a custom TenuVault Backup Writer role (read and write blobs, no delete) assigned to the reader on that container only, turns on blob versioning, and adds a lifecycle rule that removes only previous blob versions.",
    `Details: ${READER_GUIDE_URL}`,
  ].join("\n")
}

/** The next step and docs page for a Backup Reader error or warning, so a failure is actionable rather than just red. */
export function readerErrorGuidance(message: string): { hint: string; url: string; label: string } {
  const text = message.toLowerCase()
  if (text.includes("aadsts700027") || text.includes("does not know this certificate")) {
    return { hint: "The certificate is not on the app registration yet, or Microsoft has not applied it. Ask your Entra administrator to run the setup script, wait a few minutes, then verify again.", url: `${READER_GUIDE_URL}#troubleshooting`, label: "Open troubleshooting" }
  }
  if (text.includes("aadsts7000222") || text.includes("certificate has expired")) {
    return { hint: "Renew the certificate above, have your Entra administrator upload it, then verify.", url: `${READER_GUIDE_URL}#renew-the-certificate`, label: "Open the renewal guide" }
  }
  if (text.includes("aadsts53003") || text.includes("workload identities blocked")) {
    return { hint: "Your Conditional Access administrator can see which workload identity policy blocked this computer's network.", url: READER_CA_GUIDE_URL, label: "Open the Conditional Access guide" }
  }
  if (text.includes("permissions changed since they were verified")) {
    return { hint: "Ask your Entra administrator to confirm the change was intended, then select Verify again. Do not verify a change nobody recognizes.", url: `${READER_GUIDE_URL}#later-changes-who-to-ask`, label: "See who to ask" }
  }
  if (text.includes("beyond read-only backup") || text.includes("missing permissions or their admin consent")) {
    return { hint: "Your Entra administrator resets the app to exactly the read-only list by running the setup script again. Then verify.", url: `${READER_GUIDE_URL}#set-it-up`, label: "Open the setup steps" }
  }
  if (text.includes("storage") || text.includes("container") || text.includes("write backups to")) {
    return { hint: "Your Azure administrator runs the storage script above (or checks the Backup Writer assignment and firewall), then you test again.", url: "https://docs.tenuvault.com/getting-started/create-storage-account/#optional-let-the-backup-reader-write-backups", label: "Open the storage steps" }
  }
  return { hint: "Wait a few minutes and try again. New certificates and permissions take a few minutes to apply in Microsoft Entra ID.", url: `${READER_GUIDE_URL}#troubleshooting`, label: "Open troubleshooting" }
}

/**
 * Whether a sign-in prompt looks like a Conditional Access session control ending the session
 * (sign-in frequency or a fresh MFA demand), where pointing at the Backup Reader actually helps.
 * Ordinary first sign-ins and consent prompts get no advertising.
 */
export function suggestsBackupReader(message: string): boolean {
  return /AADSTS70044|AADSTS50076|AADSTS50079/i.test(message)
}
