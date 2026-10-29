import { describe, expect, it } from "vitest"
import { readerAzureRequest, readerEntraRequest, readerErrorGuidance, readerStorageCommand, readerView, scheduledIdentity, suggestsBackupReader } from "../src/renderer/lib/backup-reader-view"
import type { BackupReaderState, BackupReaderStatus } from "../src/shared/ipc"

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
  verifiedRoles: ["DeviceManagementConfiguration.Read.All"],
  excludedTypes: ["DeviceCategories", "DeviceCleanupRules"],
  renewalPending: false,
  ...overrides,
})
const state = (reader: BackupReaderStatus | null, overrides: Partial<BackupReaderState> = {}): BackupReaderState => ({ supported: true, available: true, reader, ...overrides })

describe("Backup Reader card", () => {
  it("keeps the device inventory permission in the renewal command when the reader has it", () => {
    const view = readerView(state(status({ verifiedRoles: ["DeviceManagementConfiguration.Read.All", "DeviceManagementManagedDevices.Read.All"], excludedTypes: [] })), NOW)
    expect(view.command).toBe("./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer> -AppId 44444444-4444-4444-4444-444444444444 -IncludeDeviceCategories")
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
    expect(readerErrorGuidance("Something else.").url).toContain("#troubleshooting")
  })

  it("suggests the reader only for session-control sign-in endings, not ordinary prompts", () => {
    expect(suggestsBackupReader("Microsoft needs you to sign in again (AADSTS70044).")).toBe(true)
    expect(suggestsBackupReader("You are not signed in to this tenant.")).toBe(false)
    expect(suggestsBackupReader("Grant consent to continue.")).toBe(false)
  })
})
