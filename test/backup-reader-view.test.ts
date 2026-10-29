import { describe, expect, it } from "vitest"
import { readerView } from "../src/renderer/lib/backup-reader-view"
import type { BackupReaderState, BackupReaderStatus } from "../src/shared/ipc"

const NOW = Date.parse("2026-10-26T12:00:00Z")
const status = (overrides: Partial<BackupReaderStatus> = {}): BackupReaderStatus => ({
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "44444444-4444-4444-4444-444444444444",
  state: "verified",
  certificatePem: "-----BEGIN CERTIFICATE-----",
  thumbprintSha256: "AB".repeat(32),
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
