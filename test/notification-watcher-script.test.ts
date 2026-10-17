import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { intuneChangeDigest, mapAuditEvent, type AuditEventRaw } from "../src/shared/notifications/audit"
import { canonicalJson } from "../src/shared/notifications/envelope"
import fixture from "./fixtures/notifications/audit-digest.json"

const runbook = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url), "utf8")
const setup = readFileSync(new URL("../resources/New-TenuVaultNotificationWatcher.ps1", import.meta.url), "utf8")
const desktopApp = readFileSync(new URL("../resources/New-TenuVaultDesktopApp.ps1", import.meta.url), "utf8")

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh"].find((candidate) => existsSync(candidate))

describe("Azure notification watcher scripts", () => {
  it("never reads audit request bodies or property values", () => {
    expect(runbook).not.toContain("requestBody")
    expect(runbook).not.toContain("modifiedProperties")
    expect(runbook).toContain("id,displayName,componentName,actor,activity,activityDateTime,activityType,activityOperationType,activityResult,category,resources")
  })

  it("claims the state lease before any delivery function runs", () => {
    const leaseAt = runbook.indexOf('"x-ms-lease-action" = "acquire"')
    expect(runbook).toContain("tenuvault-notification-state")
    expect(leaseAt).toBeGreaterThan(0)
    expect(runbook.toLowerCase()).toContain("lease")
    const deliveryAt = runbook.indexOf("Send-TvWebhook", leaseAt)
    expect(deliveryAt).toBeGreaterThan(leaseAt)
  })

  it("keeps the backup recovery key and sealed manifests out of the watcher", () => {
    expect(runbook).not.toContain("TVAZ1")
    expect(runbook).not.toContain("metadata.json")
    expect(runbook).toContain("intune-backups")
  })

  it("setup scopes storage roles to containers and gates Graph roles behind a switch", () => {
    expect(setup).toContain("Storage Blob Data Reader")
    expect(setup).toContain("Storage Blob Data Contributor")
    expect(setup).toContain("tenuvault-notification-state")
    expect(setup).toContain("-GrantGraphRoles")
    expect(setup).toContain("DeviceManagementApps.Read.All")
    expect(setup).toContain("-AssignSystemIdentity")
    expect(setup).not.toMatch(/New-AzADAppCredential|client.?secret/i)
  })

  it("keeps a persistent outbox, a renewed finite lease, Automation identity and a config gate", () => {
    for (const marker of [
      "pendingEnvelopes",
      "deadEnvelopes",
      '"x-ms-lease-duration" = "60"',
      '"x-ms-lease-action" = "renew"',
      "deliveredChannels",
      "attemptsByChannel",
      "mailVerifiedSender",
      "IDENTITY_ENDPOINT",
      "X-IDENTITY-HEADER",
      "$listXml.EnumerationResults.Blobs",
      "$blobsNode.BlobPrefix",
      "Unsupported TenuVaultConfigVersion",
      "configHash",
      "[switch]$VerifyMailOnly",
      "mailVerified",
    ]) {
      expect(runbook).toContain(marker)
    }
    // Intents are persisted before delivery is attempted.
    expect(runbook.indexOf("Save-TvState")).toBeGreaterThan(0)
    expect(setup).toContain("[string]$AlertEmail")
    expect(setup).toContain("Mail.Send")
  })

  it("desktop setup adds notification scopes only with the opt-in switch", () => {
    expect(desktopApp).toContain("[switch]$IncludeNotifications")
    const at = desktopApp.indexOf("if ($IncludeNotifications)")
    expect(at).toBeGreaterThan(0)
    expect(desktopApp.indexOf('"Mail.Send"')).toBeGreaterThan(at)
    expect(desktopApp.indexOf('"GroupMember.Read.All"')).toBeGreaterThan(at)
    expect(desktopApp.indexOf('"User.Read.All"')).toBeGreaterThan(at)
  })

  it.runIf(Boolean(pwsh))("PowerShell renders the identical canonical digest as TypeScript", () => {
    const changes = fixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)!)
    const expected = canonicalJson(intuneChangeDigest({ tenantId: fixture.tenantId, tenantName: fixture.tenantName, changes, includeActor: fixture.includeActor, source: "azure-watcher" }))
    const script = new URL("./fixtures/notifications/render-digest.ps1", import.meta.url).pathname
    const output = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim()
    expect(output).toBe(expected)
  }, 60_000)
})
