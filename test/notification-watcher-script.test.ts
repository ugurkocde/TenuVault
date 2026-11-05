import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { intuneChangeDigest, mapAuditEvent, type AuditEventRaw } from "../src/shared/notifications/audit"
import { canonicalJson } from "../src/shared/notifications/envelope"
import { teamsWorkflowsPayload } from "../src/shared/notifications/render"
import fixture from "./fixtures/notifications/audit-digest.json"
import liveFixture from "./fixtures/notifications/audit-live.json"
import entraFixture from "./fixtures/notifications/entra-audit.json"
import { entraChangeDigest } from "../src/shared/notifications/audit"
import { mapEntraAuditEvent, type EntraAuditRaw } from "../src/shared/notifications/entra"

const runbook = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url), "utf8")
const setup = readFileSync(new URL("../resources/New-TenuVaultNotificationWatcher.ps1", import.meta.url), "utf8")
const desktopApp = readFileSync(new URL("../resources/New-TenuVaultDesktopApp.ps1", import.meta.url), "utf8")

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))

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
    // Conditional Access watching is opt-in on both sides.
    expect(setup).toContain("[switch]$IncludeConditionalAccess")
    expect(setup).toContain("AuditLog.Read.All")
    expect(runbook).toContain("TenuVaultWatchConditionalAccess")
    expect(runbook).toContain("entraWatermark")
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
    expect([...runbook].every((char) => char.codePointAt(0)! <= 0x7f)).toBe(true)
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
    const script = fileURLToPath(new URL("./fixtures/notifications/render-digest.ps1", import.meta.url))
    const output = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim()
    expect(output).toBe(expected)
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell renders designed HTML mail with escaped tenant text", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/render-mail.ps1", import.meta.url))
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

  it.runIf(Boolean(pwsh))("PowerShell builds the identical Teams card as TypeScript for every severity", () => {
    const changes = fixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)!)
    const digest = intuneChangeDigest({ tenantId: fixture.tenantId, tenantName: fixture.tenantName, changes, includeActor: fixture.includeActor, source: "azure-watcher" })
    const script = fileURLToPath(new URL("./fixtures/notifications/render-teams.ps1", import.meta.url))
    for (const severity of ["info", "warning", "critical"] as const) {
      const output = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Severity", severity], { encoding: "utf8" }).trim()
      expect(output).toBe(canonicalJson(teamsWorkflowsPayload({ ...digest, severity })))
    }
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell builds the identical Conditional Access digest and card as TypeScript", () => {
    const changes = entraFixture.events.map((event) => mapEntraAuditEvent(event as EntraAuditRaw)).filter((change) => change !== null)
    const digest = entraChangeDigest({ tenantId: entraFixture.tenantId, tenantName: entraFixture.tenantName, changes, includeActor: entraFixture.includeActor, source: "azure-watcher" })
    const script = fileURLToPath(new URL("./fixtures/notifications/render-entra.ps1", import.meta.url))
    const [digestJson, cardJson] = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/)
    expect(digestJson).toBe(canonicalJson(digest))
    expect(cardJson).toBe(canonicalJson(teamsWorkflowsPayload(digest)))
    expect(digestJson).not.toContain("SECRET_MARKER")
    expect(digestJson).not.toContain("198.51.100.23")
  }, 60_000)

  it.runIf(Boolean(pwsh))("watcher ingestion pages, dedupes, restarts an expired continuation and keeps state on failure", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/ingest.ps1", import.meta.url))
    const [paged, restarted, failed, foreignSaved, foreignNext, pruning] = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line))
    // The known id, the failed strength create and the Core Directory event are left out.
    expect(paged.ids).toEqual([
      "Authentication Methods_bbbbbbbb-0000-0000-0000-000000000003_Y_3",
      "Authentication Methods_bbbbbbbb-0000-0000-0000-000000000004_Y_4",
      "IPCGraph_dddddddd-0000-0000-0000-000000000006_X_6",
      "IPCGraph_eeeeeeee-0000-0000-0000-000000000007_X_7",
    ])
    expect(paged.newest).toBe("2026-11-04T08:10:00.000Z")
    expect(paged.continuation).toBeNull()
    expect(paged.calls).toEqual(["https://graph.microsoft.com/v1.0/fresh", "https://graph.microsoft.com/v1.0/next?page=2"])
    expect(restarted.calls[0]).toBe("https://graph.microsoft.com/v1.0/expired")
    expect(restarted.calls[1]).toBe("https://graph.microsoft.com/v1.0/fresh")
    expect(restarted.error).toBeNull()
    expect(failed.ids).toEqual([])
    expect(failed.newest).toBe("2026-11-03T22:00:00.000Z")
    expect(failed.continuation).toBe("https://graph.microsoft.com/v1.0/saved")
    expect(failed.error).toContain("Conditional Access audit ingestion failed")
    // The Graph token only ever goes to Microsoft Graph.
    expect(foreignSaved.calls[0]).toBe("https://graph.microsoft.com/v1.0/fresh")
    expect(foreignSaved.calls.every((url: string) => url.startsWith("https://graph.microsoft.com/"))).toBe(true)
    expect(foreignNext.calls.every((url: string) => url.startsWith("https://graph.microsoft.com/"))).toBe(true)
    expect(foreignNext.error).toContain("not a Microsoft Graph address")
    expect(foreignNext.ids).toEqual([])
    // A run that stopped inside a page keeps every dedupe id until that page is read again.
    expect(pruning.ids).toEqual(["new"])
    expect([...pruning.kept].sort()).toEqual(["new", "old"])
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell matches TypeScript on live-shaped read and assignment events", () => {
    const changes = liveFixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)).filter((change) => change !== null)
    expect(changes.map((change) => change.changeType)).toEqual(["assigned", "unassigned", "created"])
    const expected = canonicalJson(intuneChangeDigest({ tenantId: liveFixture.tenantId, tenantName: liveFixture.tenantName, changes, includeActor: liveFixture.includeActor, source: "azure-watcher" }))
    const script = fileURLToPath(new URL("./fixtures/notifications/render-digest.ps1", import.meta.url))
    const livePath = fileURLToPath(new URL("./fixtures/notifications/audit-live.json", import.meta.url))
    const output = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-FixturePath", livePath], { encoding: "utf8" }).trim()
    expect(output).toBe(expected)
  }, 60_000)
})
