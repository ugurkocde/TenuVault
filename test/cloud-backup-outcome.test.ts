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
    expect(events.slice(6)).toEqual([null, null, null, null])
  })

  it("is the only unsealed write, to the watcher's container and with fixed fields", () => {
    expect(backupRunbook.match(/Invoke-TvHttp -Uri \$target\.Uri -Token \$Token -Method "Put"/g)).toHaveLength(1)
    const plain = backupRunbook.match(/Invoke-TvHttp -Uri \$uri -Token \$Token -Method "Put"/g)
    expect(plain).toHaveLength(1)
    expect(backupRunbook).toContain('$script:OutcomeContainer = "tenuvault-notification-state"')
    expect(backupRunbook).toContain('/$script:OutcomeContainer/cloud-backup-outcomes/')
    // Every path that ends a run leaves a note: Key Vault, listing, write phase and the result.
    expect(backupRunbook.match(/Send-TvBackupOutcome -Account/g)).toHaveLength(4)
  })

  it("the watcher leaves failed folders out of the missed backup check and remembers them in its state", () => {
    const watcher = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url), "utf8")
    expect(watcher).toContain('if ($failedBackupFolders.Contains($name.TrimEnd("/"))) { continue }')
    expect(watcher).toContain("failedBackupFolders = @($failedBackupFolders.ToArray()")
    // Notes are deleted only after the state with their alerts is saved.
    expect(watcher.indexOf("foreach ($blobName in $processedOutcomeNames)")).toBeGreaterThan(watcher.indexOf("$watermarkIso = $newestSeenIso\n    & $saveState"))
  })

  it.runIf(Boolean(pwsh))("writes one create-only note per run that parses as a valid note, and never throws", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/backup-outcome-note.ps1", import.meta.url))
    const [first, second] = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line))
    const calls = Array.isArray(first.calls) ? first.calls : [first.calls]
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: "Put", ifNoneMatch: "*", contentType: "application/json", uri: "https://stcontoso.blob.core.windows.net/tenuvault-notification-state/cloud-backup-outcomes/backup-2026-11-05-020000.json" })
    const note = JSON.parse(calls[0].body)
    expect(Object.keys(note).sort()).toEqual(["backupFolder", "failedTypes", "failures", "finishedAt", "runId", "schema", "status", "tenantId", "totalPolicies"])
    expect(parseCloudOutcome(note, TENANT)).toMatchObject({ status: "CompletedWithWarnings", totalPolicies: 398, failures: 3, failedTypes: ["Apps", "Remediations"] })
    const missing = Array.isArray(second.calls) ? second.calls : [second.calls]
    expect(missing[0].uri).toContain("/cloud-backup-outcomes/run-a1b2c3d4-0000-4000-8000-000000000009.json")
    expect(JSON.stringify(second.output)).toContain("No notification watcher state container")
  }, 60_000)

  it.runIf(Boolean(pwsh))("the watcher reads notes across list pages, alerts on valid ones and remembers failed folders", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/outcome-read.ps1", import.meta.url))
    const [read, failed] = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line))
    expect(read.types).toEqual(["backup.warning", "backup.failed", "backup.failed"])
    expect(read.failedFolders).toEqual(["backup-2026-11-07-020000"])
    // The note of another tenant is ignored and kept, so it is never deleted by this watcher.
    expect(read.processed).toHaveLength(3)
    expect(read.processed).not.toContain("cloud-backup-outcomes/run-other-tenant.json")
    expect(read.ignored).toBe(1)
    expect(read.error).toBeNull()
    expect(read.renewals).toBe(2)
    expect(failed).toEqual({ count: 0, error: expect.stringContaining("Cloud backup results could not be read") })
  }, 60_000)
})
