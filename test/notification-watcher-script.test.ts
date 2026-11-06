import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { intuneChangeDigest, mapAuditEvent, type AuditEventRaw } from "../src/shared/notifications/audit"
import { canonicalJson } from "../src/shared/notifications/envelope"
import { TEAMS_MESSAGE_BUDGET_BYTES, teamsPayloadBytes, teamsWorkflowsPayload } from "../src/shared/notifications/render"
import { parseCardStyle } from "../src/shared/notifications/layout"
import { backupEvent, buildEnvelope, testEvent } from "../src/shared/notifications/envelope"
import layoutFixture from "./fixtures/notifications/card-layouts.json"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fixture from "./fixtures/notifications/audit-digest.json"
import liveFixture from "./fixtures/notifications/audit-live.json"
import outcomeFixture from "./fixtures/notifications/cloud-outcomes.json"
import { cloudOutcomeEvent, parseCloudOutcome } from "../src/shared/notifications/cloud-outcome"
import entraFixture from "./fixtures/notifications/entra-audit.json"
import { entraChangeDigest } from "../src/shared/notifications/audit"
import { mapEntraAuditEvent, type EntraAuditRaw } from "../src/shared/notifications/entra"
import { WATCHER_ALERTS_SCHEMA, watcherAlertsHash, type WatcherAlerts } from "../src/shared/notifications/alerts"

const runbook = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url), "utf8")
const setup = readFileSync(new URL("../resources/New-TenuVaultNotificationWatcher.ps1", import.meta.url), "utf8")
const desktopApp = readFileSync(new URL("../resources/New-TenuVaultDesktopApp.ps1", import.meta.url), "utf8")

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))

describe("Azure notification watcher scripts", () => {
  it("never reads audit request bodies, and touches property values only to name changed settings", () => {
    expect(runbook).not.toContain("requestBody")
    expect(runbook).toContain("id,displayName,componentName,actor,activity,activityDateTime,activityType,activityOperationType,activityResult,category,resources")
    // Old and new values are read in the changed settings library only, which returns names.
    const start = runbook.indexOf("# Library: changed setting names")
    const end = runbook.indexOf("# Library: audit event mapping")
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    for (const marker of ["modifiedProperties", "oldValue", "newValue"]) {
      let at = runbook.indexOf(marker)
      expect(at).toBeGreaterThan(0)
      while (at >= 0) {
        expect(at > start && at < end).toBe(true)
        at = runbook.indexOf(marker, at + 1)
      }
    }
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
    // The Teams card layout reaches the watcher as an Automation variable.
    expect(setup).toContain("[string]$TeamsCardLayoutPath")
    expect(setup).toContain('"TenuVaultTeamsCardLayout"')
    expect(runbook).toContain("Get-TvCardStyleFor $Layout")
    // The layout file is read as UTF-8, checked before any Azure write, and only written when passed.
    expect(setup).toContain("Get-Content -LiteralPath $TeamsCardLayoutPath -Raw -Encoding UTF8")
    expect(setup.indexOf("Teams card layout file not found")).toBeLessThan(setup.indexOf("Writing Automation variables"))
    expect(setup).toContain('if ($PSBoundParameters.ContainsKey("TeamsCardLayoutPath"))')
  })

  it("takes the alerts from TenuVault as a file in the state container, checked before any Azure write", () => {
    expect(setup).toContain("[string]$AlertRulesPath")
    expect(setup).toContain('"TenuVaultAlertRules"')
    expect(setup).toContain('$alertsBlobName = "alerts.json"')
    expect(runbook).toContain('$alertsBlobUri = "$stateContainerUri/alerts.json"')
    expect(runbook.match(/alertsSource = \$alertsSource/g)).toHaveLength(4)
    expect(setup).toContain("Get-Content -LiteralPath $AlertRulesPath -Raw -Encoding UTF8")
    expect(setup.indexOf("The alerts file has no alert")).toBeLessThan(setup.indexOf("Writing Automation variables"))
    expect(setup).toContain('if ($PSBoundParameters.ContainsKey("AlertRulesPath"))')
    expect(runbook).toContain('Get-TvAutomationVariable "TenuVaultAlertRules"')
    // An unreadable value falls back to sending everything, never to silence.
    expect(runbook).toContain("every event goes to every destination until it is set again")
    expect(runbook).toContain("holds no alert this runbook can use")
    // The heartbeat says which alerts the watcher runs, also when a run fails.
    expect(runbook.match(/alertsHash = \$alertsHash/g)).toHaveLength(4)
    expect(setup).toContain("No alert in the file takes these watcher events")
    expect(runbook).toContain("alertRules=")
  })

  it.runIf(Boolean(pwsh))("setup spreads runs faster than hourly over extra hourly schedules and cleans them up", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/setup-harness.ps1", import.meta.url))
    type Schedule = { name: string; interval: number; minute: number; linked: boolean }
    // The harness adds an unrelated TenuVaultNotificationCheck-7 first; it must survive every run, -Remove included.
    const runs = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Scenario", "schedules"], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line)).map((run) => {
      expect(run.schedules.some((schedule: Schedule) => schedule.name === "TenuVaultNotificationCheck-7")).toBe(true)
      return { ...run, schedules: run.schedules.filter((schedule: Schedule) => schedule.name !== "TenuVaultNotificationCheck-7") }
    })
    const names = (run: { schedules: Schedule[] }) => run.schedules.map((schedule) => schedule.name)
    // The countdown to the first run moves with the clock; everything else must be identical.
    const stable = (run: { schedules: Array<Schedule & { startsInMinutes?: number }>; links: string[] }) => ({ links: run.links, schedules: run.schedules.map(({ startsInMinutes: _countdown, ...rest }) => rest) })
    const [hourly, quarter, again, half, back, fourHours, twenty, removed] = runs
    expect(names(hourly)).toEqual(["TenuVaultNotificationCheck"])
    const base = hourly.schedules[0].minute
    // A new schedule first runs about 10 minutes from now, not an hour later.
    expect(hourly.schedules[0].startsInMinutes).toBeGreaterThan(5)
    expect(hourly.schedules[0].startsInMinutes).toBeLessThan(11)
    // Every 15 minutes: four hourly schedules, linked, 15 minutes apart from the base schedule's minute.
    expect(names(quarter)).toEqual(["TenuVaultNotificationCheck", "TenuVaultNotificationCheck-2", "TenuVaultNotificationCheck-3", "TenuVaultNotificationCheck-4"])
    expect(quarter.schedules.map((schedule: Schedule) => schedule.minute)).toEqual([0, 15, 30, 45].map((offset) => (base + offset) % 60))
    expect(quarter.schedules.every((schedule: Schedule) => schedule.interval === 1 && schedule.linked)).toBe(true)
    // A rerun with the same interval changes nothing.
    expect(stable(again)).toEqual(stable(quarter))
    expect(half.schedules.map((schedule: Schedule) => [schedule.name, schedule.minute])).toEqual([["TenuVaultNotificationCheck", base], ["TenuVaultNotificationCheck-2", (base + 30) % 60]])
    expect(stable(back)).toEqual(stable(hourly))
    expect(fourHours.schedules).toMatchObject([{ name: "TenuVaultNotificationCheck", interval: 4, linked: true }])
    expect(twenty.schedules.map((schedule: Schedule) => schedule.interval)).toEqual([1, 1, 1])
    const twentyBase = twenty.schedules[0].minute
    expect(twenty.schedules.map((schedule: Schedule) => schedule.minute)).toEqual([0, 20, 40].map((offset) => (twentyBase + offset) % 60))
    expect(twenty.links).toEqual(names(twenty))
    expect(removed.schedules).toEqual([])
    expect(removed.links).toEqual([])
    // A schedule turned off by an administrator is reported, never turned back on.
    const disabled = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Scenario", "disabled"], { encoding: "utf8" })
    expect(disabled).toContain("Schedule 'TenuVaultNotificationCheck' is turned off or expired")
    expect(JSON.parse(disabled.trim().split(/\r?\n/).at(-1)!)).toEqual({ enabled: false })
    const conflict = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Scenario", "conflict"], { encoding: "utf8" }).trim())
    expect(conflict.error).toContain("contradict each other")
  }, 120_000)

  it.runIf(Boolean(pwsh))("setup writes the alerts to alerts.json, keeps them on a rerun and deletes them with an empty path", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/setup-harness.ps1", import.meta.url))
    const [before, written, kept, cleared] = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Scenario", "alerts"], { encoding: "utf8" }).trim().split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
    expect(before.alertsBlob).toBeNull()
    expect(JSON.parse(written.alertsBlob).alerts[0].conditions.policyNameMatch).toBe("exact")
    expect(written.alertsBlobType).toBe("application/json; charset=utf-8")
    // The older variable is emptied, so only one copy of the alerts exists.
    expect(written.alertRulesVariable).toBe("")
    expect(kept.alertsBlob).toBe(written.alertsBlob)
    expect(cleared.alertsBlob).toBeNull()
    // A file that cannot be checked is never reported as removed.
    const [failed, after] = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Scenario", "forbidden"], { encoding: "utf8" }).trim().split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
    expect(failed.error).toContain("Could not check 'alerts.json'")
    expect(after.kept).toBe(true)
  }, 120_000)

  it.runIf(Boolean(pwsh))("the watcher runs the alerts from alerts.json, else from setup, and never falls silent", () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-run-"))
    const document: WatcherAlerts = { schema: WATCHER_ALERTS_SCHEMA, alerts: [{ id: "exact", title: "Exact", eventTypes: ["intune.change"], minSeverity: "info", destinations: ["webhook"], delivery: "each", conditions: { changeTypes: [], categories: [], policyNames: ["tv-alerts-test compliance"], policyNameMatch: "exact", settingNames: [], excludeActors: [] } }] }
    const older: WatcherAlerts = { schema: WATCHER_ALERTS_SCHEMA, alerts: [{ id: "teams", title: "Teams", eventTypes: ["intune.change"], minSeverity: "info", destinations: ["teams"], delivery: "digest", conditions: null }] }
    const run = (blob: string, variable: string, readFails = false) => {
      const blobPath = join(dir, `blob-${Math.random()}.json`)
      const variablePath = join(dir, `variable-${Math.random()}.json`)
      writeFileSync(blobPath, blob)
      writeFileSync(variablePath, variable)
      const script = fileURLToPath(new URL("./fixtures/notifications/run-watcher.ps1", import.meta.url))
      return JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, "-AlertsBlobPath", blobPath, "-AlertsVariablePath", variablePath, ...(readFails ? ["-AlertsReadFails"] : [])], { encoding: "utf8" }).trim()) as { posts: Array<{ host: string; title: string }>; heartbeat: Record<string, unknown>; output: string[] }
    }
    // alerts.json wins over the variable, written by the app as pretty JSON with a byte order mark.
    const fromFile = run(`\ufeff${JSON.stringify(document, null, 2)}\n`, JSON.stringify(older))
    expect(fromFile.heartbeat).toMatchObject({ alertsSource: "storage", alertsHash: watcherAlertsHash(document), runbookVersion: "1.2.0", lastError: null })
    expect(fromFile.posts.map((post) => post.host)).toEqual(["hooks.example.test", "hooks.example.test"])
    expect(fromFile.posts.map((post) => post.title)).toEqual(["Intune change: TV-ALERTS-TEST compliance created", "Intune change: TV-ALERTS-TEST compliance updated"])
    // Without the file, a watcher set up earlier keeps the alerts of its setup.
    const fromSetup = run("", JSON.stringify(older))
    expect(fromSetup.heartbeat).toMatchObject({ alertsSource: "setup", alertsHash: watcherAlertsHash(older) })
    expect(fromSetup.posts.map((post) => post.host)).toEqual(["contoso.webhook.office.com"])
    // An unreadable file sends every event everywhere and says so.
    const unreadable = run("not json", JSON.stringify(older))
    expect(unreadable.heartbeat).toMatchObject({ alertsSource: "storage", alertsHash: "unreadable" })
    expect(new Set(unreadable.posts.map((post) => post.host))).toEqual(new Set(["hooks.example.test", "contoso.webhook.office.com"]))
    expect(unreadable.output.join("\n")).toContain("alerts.json could not be read; every event goes to every destination")
    // An empty file says so and sends everything, like a damaged one.
    const blank = run(" \n", JSON.stringify(older))
    expect(blank.heartbeat).toMatchObject({ alertsSource: "storage", alertsHash: "unreadable" })
    expect(blank.output.join("\n")).toContain("alerts.json could not be read; every event goes to every destination")
    expect(new Set(blank.posts.map((post) => post.host))).toEqual(new Set(["hooks.example.test", "contoso.webhook.office.com"]))
    // A file that cannot be read never brings back the older setup alerts: everything goes everywhere.
    const failedRead = run(JSON.stringify(document), JSON.stringify(older), true)
    expect(failedRead.heartbeat).toMatchObject({ alertsSource: "storage", alertsHash: "unreadable", lastError: null })
    expect(failedRead.output.join("\n")).toContain("alerts.json could not be read (")
    expect(new Set(failedRead.posts.map((post) => post.host))).toEqual(new Set(["hooks.example.test", "contoso.webhook.office.com"]))
    const none = run("", "")
    expect(none.heartbeat).toMatchObject({ alertsSource: "none", alertsHash: "none" })
    expect(new Set(none.posts.map((post) => post.host))).toEqual(new Set(["hooks.example.test", "contoso.webhook.office.com"]))
  }, 180_000)

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
    const [paged, restarted, failed, foreignSaved, foreignNext, pruning, capped, recovered] = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line))
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
    // A run stopped by the cap keeps its continuation and does not move the watermark past unread pages.
    expect(capped.ids).toHaveLength(500)
    expect(capped.continuation).toBe("https://graph.microsoft.com/v1.0/fresh")
    expect(capped.newest).toBe("2026-11-03T22:00:00.000Z")
    // After the continuation expires, the restart brings the events the capped run did not reach, and none twice.
    expect(recovered.calls).toEqual(["https://graph.microsoft.com/v1.0/expired", "https://graph.microsoft.com/v1.0/fresh"])
    expect(recovered.ids).toHaveLength(21)
    expect(recovered.ids.filter((id: string) => capped.ids.includes(id))).toEqual([])
    expect(recovered.continuation).toBeNull()
    expect(recovered.newest).toBe("2026-11-04T09:00:00.000Z")
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell builds the identical card for every layout in the matrix", () => {
    const changes = fixture.events.map((event) => mapAuditEvent(event as AuditEventRaw)!)
    const envelopes = [
      intuneChangeDigest({ tenantId: fixture.tenantId, tenantName: fixture.tenantName, changes, includeActor: true, source: "azure-watcher" }),
      entraChangeDigest({ tenantId: entraFixture.tenantId, tenantName: entraFixture.tenantName, changes: entraFixture.events.map((event) => mapEntraAuditEvent(event as EntraAuditRaw)).filter((change) => change !== null), includeActor: false, source: "azure-watcher" }),
      backupEvent({ tenantId: fixture.tenantId, tenantName: null, status: "Failed", backupFolder: "backup-2026-10-17-020000", occurredAt: "2026-10-17T02:05:00.000Z", totalPolicies: 0, failures: 3, failedTypes: ["Apps"], trigger: "scheduled", source: "azure-watcher" }),
      testEvent({ tenantId: fixture.tenantId, tenantName: "Contoso", occurredAt: "2026-10-17T10:00:00.000Z", channelTitle: "IT [Ops]", source: "azure-watcher" }),
    ]
    const dir = mkdtempSync(join(tmpdir(), "tv-layouts-"))
    const envelopesPath = join(dir, "envelopes.json")
    writeFileSync(envelopesPath, JSON.stringify(envelopes))
    const script = fileURLToPath(new URL("./fixtures/notifications/render-layouts.ps1", import.meta.url))
    const lines = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-EnvelopesPath", envelopesPath], { encoding: "utf8" }).trim().split(/\r?\n/)
    const expected = Object.values(layoutFixture.styles).flatMap((raw) => envelopes.map((envelope) => canonicalJson(teamsWorkflowsPayload(envelope, parseCardStyle(raw)))))
    expect(lines).toHaveLength(expected.length)
    lines.forEach((line, index) => expect(line, `style/envelope pair ${index}`).toBe(expected[index]))
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell shortens oversized cards exactly like TypeScript, under the Teams limit", () => {
    const huge = (character: string) => character.repeat(2000)
    const envelopes = ["a", ".", "\u00fc"].map((character) => buildEnvelope({
      type: "intune.change", severity: "critical", tenantId: fixture.tenantId, tenantName: huge(character), occurredAt: "2026-11-05T08:42:00.000Z", naturalKey: `huge-${character}`,
      title: huge(character), summary: huge(character),
      details: Array.from({ length: 20 }, () => ({ label: huge(character), value: huge(character) })),
      items: Array.from({ length: 20 }, () => ({ title: huge(character), detail: huge(character), actor: huge(character), at: "2026-11-05T08:42:00.000Z" })),
      moreCount: 5, source: "azure-watcher",
    }))
    const dir = mkdtempSync(join(tmpdir(), "tv-oversized-"))
    const envelopesPath = join(dir, "envelopes.json")
    writeFileSync(envelopesPath, JSON.stringify(envelopes))
    const script = fileURLToPath(new URL("./fixtures/notifications/render-oversized.ps1", import.meta.url))
    const lines = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-EnvelopesPath", envelopesPath], { encoding: "utf8" }).trim().split(/\r?\n/)
    envelopes.forEach((envelope, index) => {
      const payload = teamsWorkflowsPayload(envelope)
      expect(teamsPayloadBytes(payload)).toBeLessThanOrEqual(TEAMS_MESSAGE_BUDGET_BYTES)
      expect(lines[index]).toBe(canonicalJson(payload))
    })
  }, 120_000)

  it.runIf(Boolean(pwsh))("PowerShell drops an oversized note exactly like TypeScript", () => {
    const envelope = buildEnvelope({ type: "test", severity: "info", tenantId: fixture.tenantId, occurredAt: "2026-11-05T08:42:00.000Z", naturalKey: "note", title: ".".repeat(200), summary: "Test.", source: "azure-watcher" })
    const raw = { hidden: [], noteText: "{title}".repeat(42), noteMinSeverity: "info" }
    const dir = mkdtempSync(join(tmpdir(), "tv-note-"))
    writeFileSync(join(dir, "envelopes.json"), JSON.stringify([envelope]))
    writeFileSync(join(dir, "style.json"), JSON.stringify(raw))
    const script = fileURLToPath(new URL("./fixtures/notifications/render-oversized.ps1", import.meta.url))
    const output = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-EnvelopesPath", join(dir, "envelopes.json"), "-StylePath", join(dir, "style.json")], { encoding: "utf8" }).trim()
    const payload = teamsWorkflowsPayload(envelope, parseCardStyle(raw))
    expect(teamsPayloadBytes(payload)).toBeLessThanOrEqual(TEAMS_MESSAGE_BUDGET_BYTES)
    expect(output).toBe(canonicalJson(payload))
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell turns cloud backup notes into the same backup events as TypeScript", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/render-outcomes.ps1", import.meta.url))
    // System.Text.Json on PowerShell 7, ConvertFrom-Json on the watcher's 5.1 runtime: both must agree.
    // The fallback keeps times as text only on 5.1 and, with -DateKind String, on 7.5 and later;
    // 7.2 to 7.4 always have System.Text.Json, so only a host with -DateKind can stand in for 5.1.
    const run = (parser: string) => execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Parser", parser], { encoding: "utf8" }).trim().split(/\r?\n/)
    const lines = run("SystemTextJson")
    const hasDateKind = execFileSync(pwsh!, ["-NoProfile", "-Command", "(Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')"], { encoding: "utf8" }).trim() === "True"
    if (hasDateKind) expect(run("ConvertFromJson")).toEqual(lines)
    const expected = outcomeFixture.notes.map((note) => {
      const outcome = parseCloudOutcome(note, outcomeFixture.tenantId)
      return outcome ? canonicalJson(cloudOutcomeEvent(outcome, outcomeFixture.tenantId, outcomeFixture.tenantName)) : "null"
    })
    expect(lines).toEqual(expected)
    // Rejected: other tenant, newer schema, path-like folder, bad status, a field wrapped in a list,
    // a trailing newline, non-ASCII digits, a missing backupFolder key, a time without a zone, and impossible times
    // (Feb 30, T24:00, an offset past 14 hours, before year 1).
    expect(expected.filter((line) => line === "null")).toHaveLength(13)
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
