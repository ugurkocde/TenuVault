import { describe, expect, it } from "vitest"
import { excludedSummary, readerAzureRequest, readerEntraRequest, readerErrorGuidance, readerStorageCommand, readerView, roleChangeNotice, scheduledIdentity, suggestsBackupReader } from "../src/renderer/lib/backup-reader-view"
import type { BackupReaderState, BackupReaderStatus } from "../src/shared/ipc"
import { readerRoles } from "../src/shared/services/manifest"

/** The five permissions every Backup Reader for Intune holds. */
const INTUNE = ["DeviceManagementApps.Read.All", "DeviceManagementConfiguration.Read.All", "DeviceManagementRBAC.Read.All", "DeviceManagementScripts.Read.All", "DeviceManagementServiceConfig.Read.All"]

const NOW = Date.parse("2026-10-26T12:00:00Z")
const status = (overrides: Partial<BackupReaderStatus> = {}): BackupReaderStatus => ({
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "44444444-4444-4444-4444-444444444444",
  state: "verified",
  certificatePem: "-----BEGIN CERTIFICATE-----",
  thumbprintSha256: "AB".repeat(32),
  thumbprint: "CD".repeat(20),
  certificateName: "TenuVault Backup Reader (LAPTOP-1)",
  verifiedAt: "2026-10-26T12:00:00Z",
  exportedCertificate: null,
  lastTest: null,
  lastRun: null,
  notAfter: "2027-10-26T12:00:00Z",
  verifiedRoles: INTUNE,
  excludedTypes: ["DeviceCategories", "DeviceCleanupRules"],
  roleChange: null,
  renewalPending: false,
  ...overrides,
})
const state = (reader: BackupReaderStatus | null, overrides: Partial<BackupReaderState> = {}): BackupReaderState => ({ supported: true, available: true, reader, setupArguments: "", ...overrides })

describe("Backup Reader card", () => {
  it("keeps the device inventory permission in the renewal command when the reader has it", () => {
    const view = readerView(state(status({ verifiedRoles: [...INTUNE, "DeviceManagementManagedDevices.Read.All"], excludedTypes: [] })), NOW)
    expect(view.command).toBe("./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer> -AppId 44444444-4444-4444-4444-444444444444 -IncludeDeviceCategories")
  })

  it("keeps the Conditional Access permission in the renewal command, so a renewal never strips it", () => {
    const view = readerView(state(status({ verifiedRoles: [...INTUNE, "DeviceManagementManagedDevices.Read.All", "Policy.Read.All"], excludedTypes: [] })), NOW)
    expect(view.command).toBe("./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer> -AppId 44444444-4444-4444-4444-444444444444 -IncludeDeviceCategories -IncludeConditionalAccess")
  })

  it("offers setup without a reader, and nothing to act on without the plan or on an unsupported platform", () => {
    expect(readerView(state(null), NOW)).toMatchObject({ reader: null, verified: false, waiting: false, canAct: true })
    expect(readerView(state(null, { available: false }), NOW).canAct).toBe(false)
    expect(readerView(state(null, { supported: false }), NOW).canAct).toBe(false)
  })

  it("shows the setup steps with a first-time command while the certificate waits", () => {
    const view = readerView(state(status({ state: "pending", clientId: "", verifiedRoles: null })), NOW)
    expect(view).toMatchObject({ verified: false, waiting: true, expiry: null })
    expect(view.command).toBe("./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer>")
  })

  it("names the left-out types by their labels", () => {
    expect(readerView(state(status()), NOW).excluded).toEqual(["device categories", "device clean-up rules"])
    expect(excludedSummary(["device categories", "device clean-up rules"])).toBe("device categories and device clean-up rules")
    // A long list, as a reader that lacks a whole service has, stays one readable sentence.
    expect(excludedSummary(["Domains", "Organization", "Groups", "Users", "Applications"])).toBe("Domains, Organization, Groups and 2 more types")
  })

  it("keeps the services and areas of the reader in the renewal command, so a renewal never changes its permissions", () => {
    const command = (roles: readonly string[]) => readerView(state(status({ verifiedRoles: [...roles] })), NOW).command.split("-AppId 44444444-4444-4444-4444-444444444444")[1]
    expect(command(readerRoles({ entra: { access: "backup" } }))).toBe(" -Services Entra")
    expect(command(readerRoles({ intune: { access: "backup" }, entra: { access: "backup", areas: ["groups", "applications"] } }))).toBe(" -Services Intune,Entra -Areas Groups,Applications")
    expect(command(readerRoles({ intune: { access: "backup", areas: ["devices"] }, defender: { access: "backup" } }))).toBe(" -Services Intune,Defender -IncludeDeviceCategories")
    expect(command(readerRoles({ conditionalAccess: { access: "backup" } }))).toBe(" -Services ConditionalAccess")
  })

  it("names the reader's permissions one by one in the renewal command when they are not whole services, while omitting excluded scopes", () => {
    const command = (roles: readonly string[]) => readerView(state(status({ verifiedRoles: [...roles] })), NOW).command.split("-AppId 44444444-4444-4444-4444-444444444444")[1]
    // Without its own parameter the script would replace this role with the five Intune ones.
    expect(command(["Domain.Read.All"])).toBe(" -Permissions Domain.Read.All")
    // A narrow extra read is preserved; excluded scopes are never echoed from older records.
    expect(command([...INTUNE, "User.Read.All"])).toBe(` -Permissions ${INTUNE.join(",")},User.Read.All`)
    expect(command([...INTUNE, "Directory.Read.All"])).toBe("")
    expect(command(["Directory.Read.All"])).toBe(" -Permissions None")
    // Entra ID short of one permission is not Entra ID: -IncludeConditionalAccess alone would remove the rest.
    const entra = readerRoles({ entra: { access: "backup" } }).filter((role) => role !== "Agreement.Read.All")
    expect(command([...INTUNE, ...entra])).toBe(` -Permissions ${[...INTUNE, ...entra].sort().join(",")}`)
    expect(command([])).toBe(" -Permissions None")
  })

  it("starts a first setup with the services the tenant backs up", () => {
    const pending = status({ state: "pending", clientId: "", verifiedRoles: null })
    expect(readerView(state(pending, { setupArguments: " -Services Entra" }), NOW).command).toBe("./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer> -Services Entra")
  })

  it("says what changed when the reader's permissions differ from the verified ones, and that backups keep running", () => {
    expect(readerView(state(status()), NOW).roleChange).toBeNull()
    const notice = roleChangeNotice(status({ roleChange: { added: ["Policy.Read.All", "Domain.Read.All"], removed: ["DeviceManagementManagedDevices.Read.All"], at: "2026-10-26T12:00:00Z" } }))!
    expect(notice).toBe("The Backup Reader's Microsoft Graph permissions changed since they were verified: added Policy.Read.All, Domain.Read.All; removed DeviceManagementManagedDevices.Read.All. Scheduled backups keep running and read only what the verified permissions still cover. Verify the Backup Reader again to use the change.")
    // The notice gets the same advice as before: ask before verifying a change nobody recognizes.
    expect(readerErrorGuidance(notice).hint).toContain("Do not verify a change nobody recognizes")
    expect(roleChangeNotice(status({ roleChange: { added: ["Policy.Read.All"], removed: [], at: "2026-10-26T12:00:00Z" } }))).toContain("verified: added Policy.Read.All. Scheduled")
  })

  it("asks for a renewal within 30 days of expiry and after it, also while an unverified renewal waits", () => {
    expect(readerView(state(status({ notAfter: "2026-12-01T12:00:00Z" })), NOW).expiry).toBeNull()
    expect(readerView(state(status({ notAfter: "2026-11-20T12:00:00Z" })), NOW)).toMatchObject({ expiry: "soon", daysLeft: 25 })
    expect(readerView(state(status({ notAfter: "2026-10-20T12:00:00Z" })), NOW).expiry).toBe("expired")
    expect(readerView(state(status({ notAfter: "2026-11-20T12:00:00Z", renewalPending: true })), NOW).expiry).toBe("soon")
  })

  it("shows the status and the renewal steps together, with the reader's application ID in the command", () => {
    const view = readerView(state(status({ renewalPending: true })), NOW)
    expect(view).toMatchObject({ verified: true, waiting: true })
    expect(view.command).toBe("./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer> -AppId 44444444-4444-4444-4444-444444444444")
  })
})

describe("scheduled identity", () => {
  it("names only a verified, unexpired reader as the identity scheduled backups run as", () => {
    expect(scheduledIdentity(status(), NOW)).toBe("reader")
    expect(scheduledIdentity(status({ notAfter: "2026-10-20T12:00:00Z" }), NOW)).toBe("expired")
    expect(scheduledIdentity(status({ state: "pending" }), NOW)).toBe("waiting")
    expect(scheduledIdentity(null, NOW)).toBe("you")
  })
})

describe("Backup Reader handoffs and guidance", () => {
  it("fills the storage command with the tenant's account and the reader's application ID", () => {
    const command = readerStorageCommand("contosobackups", "44444444-4444-4444-4444-444444444444")
    expect(command).toContain("-StorageAccountName contosobackups")
    expect(command).toContain("-BackupReaderAppId 44444444-4444-4444-4444-444444444444")
    expect(readerStorageCommand(undefined, "")).toContain("-BackupReaderAppId <application ID from the setup script>")
  })

  it("gives copyable requests naming what each administrator runs and sends back", () => {
    const entra = readerEntraRequest("./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer>", false)
    expect(entra).toContain("public certificate only")
    expect(entra).toContain("application (client) ID and certificate thumbprint")
    expect(entra).toContain("https://docs.tenuvault.com/backups/backup-reader/")
    expect(readerEntraRequest("x", true)).toContain("renewal certificate")
    const azure = readerAzureRequest("./New-TenuVaultStorage.ps1 -X", "contosobackups")
    expect(azure).toContain("storage account contosobackups")
    expect(azure).toContain("without delete access")
  })

  it("maps known failures to the right colleague and docs page, and defaults to wait and retry", () => {
    expect(readerErrorGuidance("Microsoft refused the Backup Reader (AADSTS700027).").hint).toContain("Entra administrator")
    expect(readerErrorGuidance("Microsoft refused the Backup Reader (AADSTS7000222).").url).toContain("#renew-the-certificate")
    expect(readerErrorGuidance("The Backup Reader's Microsoft Graph permissions changed since they were verified.").hint).toContain("Do not verify a change nobody recognizes")
    expect(readerErrorGuidance("The Backup Reader works for Microsoft Graph, but cannot write backups to x.").hint).toContain("Azure administrator")
    expect(readerErrorGuidance("The Backup Reader has no permission to read Entra ID, which is all this tenant backs up. Have your Entra administrator run the setup script with -Services Entra, then verify again.").url).toContain("#permissions")
    expect(readerErrorGuidance("Something else.").url).toContain("#troubleshooting")
  })

  it("suggests the reader only for session-control sign-in endings, not ordinary prompts", () => {
    expect(suggestsBackupReader("Microsoft needs you to sign in again (AADSTS70044).")).toBe(true)
    expect(suggestsBackupReader("You are not signed in to this tenant.")).toBe(false)
    expect(suggestsBackupReader("Grant consent to continue.")).toBe(false)
  })
})

it("keeps the existing guidance priority when an error names several sign-in codes", () => {
  expect(readerErrorGuidance("AADSTS7000222 followed by AADSTS700027")).toEqual(readerErrorGuidance("AADSTS700027"))
  expect(suggestsBackupReader("AADSTS999999 followed by AADSTS50076")).toBe(true)
})
