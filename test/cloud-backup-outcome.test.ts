import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { cloudOutcomeEvent, parseCloudOutcome } from "../src/shared/notifications/cloud-outcome"
import outcomeFixture from "./fixtures/notifications/cloud-outcomes.json"

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))
const backupRunbook = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url), "utf8")
const TENANT = outcomeFixture.tenantId

describe("cloud backup result notes", () => {
  const events = outcomeFixture.notes.map((note) => parseCloudOutcome(note, TENANT)).map((outcome) => (outcome ? cloudOutcomeEvent(outcome, TENANT, "Contoso") : null))

  it("become the same backup events the desktop sends, keyed by folder or run", () => {
    expect(events.slice(0, 4).map((event) => [event!.type, event!.severity])).toEqual([
      ["backup.succeeded", "info"],
      ["backup.warning", "warning"],
      ["backup.failed", "critical"],
      ["backup.failed", "critical"],
    ])
    expect(events[1]!.details).toEqual(expect.arrayContaining([{ label: "Failed types", value: "Apps, Remediations" }, { label: "Item failures", value: "3" }, { label: "Policies saved", value: "398" }]))
    // A run that failed before claiming a folder has no Backup row and its own identity.
    expect(events[3]!.details.map((entry) => entry.label)).not.toContain("Backup")
    expect(events[3]!.eventId).not.toBe(events[2]!.eventId)
    expect(events[0]!.summary).toBe("The cloud backup in Azure completed successfully.")
  })

  it("repair bad counts and type names, and reject notes of other tenants, schemas or shapes", () => {
    const repaired = parseCloudOutcome(outcomeFixture.notes[4], TENANT)!
    expect(repaired).toMatchObject({ totalPolicies: null, failures: 0, failedTypes: [] })
    expect(parseCloudOutcome(outcomeFixture.notes[5], TENANT)!.failedTypes).toEqual(["Apps", "Remediations"])
    expect(events.slice(6, 10)).toEqual([null, null, null, null])
    // Lists for strings, a trailing newline, non-ASCII digits, a missing folder key and a zoneless time.
    expect(events.slice(10, 13)).toEqual([null, null, null])
    expect(parseCloudOutcome(outcomeFixture.notes[13], TENANT)).toMatchObject({ totalPolicies: 3, failures: 1000, failedTypes: ["Apps"] })
    expect(events.slice(14, 16)).toEqual([null, null])
    expect(parseCloudOutcome(outcomeFixture.notes[16], TENANT)!.finishedAt).toBe("2026-11-12T02:05:00.000Z")
    // Impossible calendar times are rejected, not rolled over: Feb 30, T24:00, an offset past 14 hours, before year 1.
    expect(events.slice(17, 20)).toEqual([null, null, null])
    expect(parseCloudOutcome(outcomeFixture.notes[20], TENANT)!.finishedAt).toBe("2028-02-29T02:00:00.000Z")
    expect(events[21]).toBeNull()
  })

  it("name a run started by hand in the alert, and count older notes without a trigger as scheduled", () => {
    const trigger = (index: number) => events[index]!.details.find((entry) => entry.label === "Trigger")?.value
    // Notes from backup runbooks before 1.4.0 carry no trigger: their alert reads as it always did.
    expect(outcomeFixture.notes[0]).not.toHaveProperty("trigger")
    expect(parseCloudOutcome(outcomeFixture.notes[0], TENANT)!.trigger).toBe("scheduled")
    expect(trigger(0)).toBe("Cloud backup schedule")
    expect(parseCloudOutcome(outcomeFixture.notes[22], TENANT)!.trigger).toBe("manual")
    expect(trigger(22)).toBe("Cloud backup, started by hand")
    expect(trigger(23)).toBe("Cloud backup schedule")
    // Only the exact value the runbook writes counts: other casing or a list is scheduled, and the note is still sent.
    expect(trigger(24)).toBe("Cloud backup schedule")
    expect(trigger(25)).toBe("Cloud backup schedule")
    // A different trigger is a different alert detail, but the same backup: the event key is the folder.
    expect(events[22]!.details).toContainEqual({ label: "Backup", value: "backup-2026-11-13-101500" })
  })

  it("is the only write outside the backup container, to the watcher's container and with fixed fields", () => {
    expect(backupRunbook.match(/Invoke-TvHttp -Uri \$target\.Uri -Token \$Token -Method "Put"/g)).toHaveLength(1)
    const plain = backupRunbook.match(/Invoke-TvHttp -Uri \$uri -Token \$Token -Method "Put"/g)
    expect(plain).toHaveLength(1)
    // Its own container: never the watcher's state container, which this identity could otherwise rewrite.
    expect(backupRunbook).toContain('$script:OutcomeContainer = "tenuvault-backup-results"')
    expect(backupRunbook).not.toMatch(/tenuvault-notification-state/)
    expect(backupRunbook).toContain('/$script:OutcomeContainer/cloud-backup-outcomes/')
    // Every path that ends a run leaves a note: tokens and scope, listing, write phase and the result.
    expect(backupRunbook.match(/Send-TvBackupOutcome -Account/g)).toHaveLength(4)
  })

  it("the watcher leaves failed folders out of the missed backup check and remembers them in its state", () => {
    const watcher = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url), "utf8")
    expect(watcher).toContain('if ($failedBackupFolders.Contains($name.TrimEnd("/"))) { continue }')
    // The watcher reads and deletes notes in their own container, granted by its setup.
    const watcherSetup = readFileSync(new URL("../resources/New-TenuVaultNotificationWatcher.ps1", import.meta.url), "utf8")
    expect(watcherSetup).toContain('$resultsContainer = "tenuvault-backup-results"')
    expect(watcherSetup).toContain('@{ Role = "Storage Blob Data Contributor"; Scope = "$($storageAccount.Id)/blobServices/default/containers/$resultsContainer" }')
    expect(watcher).toContain('$resultsContainerUri = "https://$storageAccount.blob.core.windows.net/tenuvault-backup-results"')
    // An unreadable results container fails the job, after state and heartbeat are saved.
    expect(watcher.indexOf("if ($outcomeRead.Error) { throw")).toBeGreaterThan(watcher.indexOf("if ($missedCheckFailed) { throw"))
    expect(watcher).toContain("failedBackupFolders = @($failedBackupFolders.ToArray()")
    // Notes are deleted only after the state with their alerts is saved.
    expect(watcher.indexOf("foreach ($blobName in $processedOutcomeNames)")).toBeGreaterThan(watcher.indexOf("$watermarkIso = $newestSeenIso\n    & $saveState"))
  })

  it.runIf(Boolean(pwsh))("writes one create-only note per run that parses as a valid note, and never throws", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/backup-outcome-note.ps1", import.meta.url))
    const [first, second] = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line))
    const calls = Array.isArray(first.calls) ? first.calls : [first.calls]
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: "Put", ifNoneMatch: "*", contentType: "application/json", uri: "https://stcontoso.blob.core.windows.net/tenuvault-backup-results/cloud-backup-outcomes/backup-2026-11-05-020000.json" })
    const note = JSON.parse(calls[0].body)
    expect(Object.keys(note).sort()).toEqual(["backupFolder", "failedTypes", "failures", "finishedAt", "runId", "schema", "status", "tenantId", "totalPolicies", "trigger"])
    expect(parseCloudOutcome(note, TENANT)).toMatchObject({ status: "CompletedWithWarnings", totalPolicies: 398, failures: 3, failedTypes: ["Apps", "Remediations"], trigger: "scheduled" })
    const missing = Array.isArray(second.calls) ? second.calls : [second.calls]
    expect(missing[0].uri).toContain("/cloud-backup-outcomes/run-a1b2c3d4-0000-4000-8000-000000000009.json")
    expect(JSON.stringify(second.output)).toContain("No tenuvault-backup-results container")
  }, 60_000)

  it.runIf(Boolean(pwsh))("the watcher reads notes across list pages, alerts on valid ones and remembers failed folders", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/outcome-read.ps1", import.meta.url))
    const [read, failed] = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line))
    expect(read.types).toEqual(["backup.warning", "backup.failed", "backup.failed"])
    // The expired failure sends nothing but still keeps its folder out of the missed check.
    expect(read.failedFolders).toEqual(["backup-2026-11-07-020000", "backup-2026-10-01-020000"])
    expect(read.expired).toBe(1)
    // Every note looked at is deleted after the save: valid, invalid, expired and oversized.
    expect(read.processed).toHaveLength(6)
    expect(read.processed).toContain("cloud-backup-outcomes/run-other-tenant.json")
    expect(read.processed).toContain("cloud-backup-outcomes/huge.json")
    expect(read.ignored).toBe(2)
    expect(read.downloadedHuge).toBe(0)
    expect(read.error).toBeNull()
    // Once per list page and once per note.
    expect(read.renewals).toBe(2 + 6)
    expect(failed).toEqual({ count: 0, error: expect.stringContaining("Cloud backup results could not be read") })
  }, 60_000)
})
