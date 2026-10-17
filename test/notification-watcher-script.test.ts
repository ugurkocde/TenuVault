import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { intuneChangeDigest, mapAuditEvent, type AuditEventRaw } from "../src/shared/notifications/audit"
import { canonicalJson } from "../src/shared/notifications/envelope"
import fixture from "./fixtures/notifications/audit-digest.json"
import liveFixture from "./fixtures/notifications/audit-live.json"

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
    expect(runbook).toContain("restype=container")
    expect(runbook).not.toContain("resttype=")
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
      "newlyExhausted",
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
    // metricAlerts only exists as 2018-03-01 in ARM; actionGroups is 2023-01-01.
    expect(setup).toContain("metricAlerts")
    expect(setup).not.toMatch(/metricAlert[^\n]*api-version=2023-01-01/)
    expect(setup).toContain("api-version=2018-03-01")
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

  it("runbook avoids type accelerators the Automation sandbox cannot resolve", () => {
    expect(runbook).not.toMatch(/\[(short|ushort|uint|ulong)\]/)
    expect(runbook).toContain("[System.Int16]")
    expect(runbook).toContain('$listText.IndexOf("<")')
    expect(setup).toContain("regional Automation account quota")
    expect(runbook).toContain("Mail send as $From failed with HTTP $statusCode")
  })

  it("watcher and desktop queries exclude read operations server side", () => {
    expect(runbook).toContain("activityOperationType ne 'Get'")
    expect(runbook).toContain("activityOperationType ne 'Search'")
    const service = readFileSync(new URL("../src/main/features/notifications/service.ts", import.meta.url), "utf8")
    expect(service).toContain("activityOperationType ne 'Get'")
    expect(service).toContain("activityOperationType ne 'Search'")
    expect(desktopApp).toContain("Mail.Send, GroupMember.Read.All and User.Read.All")
  })

  it.runIf(Boolean(pwsh))("PowerShell renders the identical canonical digest as TypeScript", () => {
    const changes = fixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)!)
    const expected = canonicalJson(intuneChangeDigest({ tenantId: fixture.tenantId, tenantName: fixture.tenantName, changes, includeActor: fixture.includeActor, source: "azure-watcher" }))
    const script = new URL("./fixtures/notifications/render-digest.ps1", import.meta.url).pathname
    const output = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim()
    expect(output).toBe(expected)
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell renders designed HTML mail with escaped tenant text", () => {
    const script = new URL("./fixtures/notifications/render-mail.ps1", import.meta.url).pathname
    const html = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" })
    expect(html).toContain("TENUVAULT")
    expect(html).toContain(">Deleted</span>")
    expect(html).toContain("2026-10-17 10:00 UTC")
    expect(html).not.toContain("2026-10-17T10:00:00")
    expect(html).toContain("https://intune.microsoft.com")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
    expect(runbook).toContain('BodyContentType "HTML"')
    expect(runbook).not.toContain("function Get-TvEmailText")
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell matches TypeScript on live-shaped read and assignment events", () => {
    const changes = liveFixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)).filter((change) => change !== null)
    expect(changes.map((change) => change.changeType)).toEqual(["assigned", "unassigned", "created"])
    const expected = canonicalJson(intuneChangeDigest({ tenantId: liveFixture.tenantId, tenantName: liveFixture.tenantName, changes, includeActor: liveFixture.includeActor, source: "azure-watcher" }))
    const script = new URL("./fixtures/notifications/render-digest.ps1", import.meta.url).pathname
    const livePath = new URL("./fixtures/notifications/audit-live.json", import.meta.url).pathname
    const output = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-FixturePath", livePath], { encoding: "utf8" }).trim()
    expect(output).toBe(expected)
  }, 60_000)
})
