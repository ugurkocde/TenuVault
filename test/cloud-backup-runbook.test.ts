import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { AuditStorageService } from "../src/portal/lib/audit/storage"
import { auditExportJSON } from "../src/portal/lib/audit/export"
import { createHash } from "node:crypto"
import { INTUNE_TYPES, typeForFolder } from "../src/shared/intune/registry"
import { verifyProjectedSnapshot } from "../src/portal/lib/policies/backup-manifest"
import { listSnapshot } from "../src/shared/intune/read"
import { comparableSnapshot } from "../src/shared/intune/compare"
import { COMPLIANCE_SETTING_KEYS, COMPLIANCE_SETTINGS_ID } from "../src/shared/intune/compliance-settings"
import { PLAIN_CLOUD_RUNBOOK, cloudRunbookNeedsUpgrade, cloudStatusBlobName, parseCloudStatus } from "../src/shared/cloud-backup"
import { resolveBackupOwnership } from "../src/shared/backup-ownership"
import { BACKUP_OWNER_FILE } from "../src/shared/constants"
import { OTHER_TENANT_BACKUP, readOwnedBackup } from "../src/portal/lib/policies/backup-owner"

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))

const runbook = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url), "utf8")
const RUNBOOK_VERSION = /\$script:RunbookVersion = "([^"]+)"/.exec(runbook)?.[1]
const setup = readFileSync(new URL("../resources/New-TenuVaultCloudBackup.ps1", import.meta.url), "utf8")
const auditSetupTimeout = 60_000
function runAuditSetup(shell: (file: string, args: string[], options: { encoding: "utf8"; timeout?: number }) => string = execFileSync) {
  const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-setup.ps1", import.meta.url))
  return shell(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8", timeout: auditSetupTimeout })
}
type RunCall = { condition?: string; uri: string; method: string; contentType: string | null; ifNoneMatch: string | null; ifMatch?: string | null; body: string | null }
type Run = { scenario?: string; calls: RunCall[]; error?: string | null; output?: string[] }
let plainRuns: Run[] | undefined
/** The scenarios of the plain-run fixture: a full run, an early failure, a failed manifest, and two runs with change reports on. */
function runPlainFixture(): Run[] {
  const script = fileURLToPath(new URL("./fixtures/cloud-backup/plain-run.ps1", import.meta.url))
  plainRuns ??= execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Run)
  return plainRuns
}
const TENANT = "11111111-2222-3333-4444-555555555555"
const BACKUP_CONTAINER_URL = "https://stcontoso.blob.core.windows.net/intune-backups/"
/** The blobs a run wrote to the backup container, by blob name, as a reader of the container sees them. */
function writtenBlobs(run: Run): Map<string, string> {
  return new Map(run.calls.filter((call) => call.method === "Put" && call.uri.startsWith(BACKUP_CONTAINER_URL))
    .map((call) => [decodeURIComponent(call.uri.slice(BACKUP_CONTAINER_URL.length)), call.body!]))
}
const read = (blobs: Map<string, string>) => async (name: string) => blobs.has(name) ? new Response(blobs.get(name)!, { status: 200, headers: { "content-type": "application/json" } }) : new Response(null, { status: 404 })
const folderOf = (blobs: Map<string, string>) => [...blobs.keys()].find((name) => name.endsWith(`/${BACKUP_OWNER_FILE}`))!.split("/")[0]!

const template = JSON.parse(readFileSync(new URL("../resources/cloud-backup/azuredeploy.json", import.meta.url), "utf8")) as {
  parameters: Record<string, unknown>
  resources: Array<{ type: string; condition?: string; dependsOn?: string[]; properties?: { scriptContent?: string } }>
  variables: Record<string, string>
  outputs: Record<string, unknown>
}

describe("Cloud audit contract", () => {
  it.runIf(Boolean(pwsh))("round trips runbook audit files through the TypeScript reader once, including early failure", async () => {
    for (const [index, status] of [[0, "completed"], [1, "failed"], [2, "failed"], [4, "warnings"]] as const) {
      const scenario = runPlainFixture()[index]!
      const writes = scenario.calls.filter(call => call.method === "Put" && call.uri.includes("/audit-logs/"))
      expect(writes).toHaveLength(1)
      const write = writes[0]!
      const file = JSON.parse(write.body!)
      const [entry] = file.entries
      expect(write.ifNoneMatch).toBe("*")
      expect(write.uri).toMatch(new RegExp(`-event-${TENANT}-${entry.job.runId}\\.json$`))
      expect(file).toMatchObject({ version: "2.0", metadata: { entryCount: 1, createdAt: entry.timestamp } })
      expect(entry).toMatchObject({ user: { tenantId: TENANT, name: "Cloud backup managed identity" },
        job: { status, producer: "cloud-runbook", producerVersion: RUNBOOK_VERSION, stage: "terminal" } })
      const note = JSON.parse(scenario.calls.find(call => call.method === "Put" && call.uri.includes("/cloud-backup-outcomes/"))!.body!)
      expect(entry.job.runId).toBe(note.runId)
      const name = new URL(write.uri).pathname.slice("/audit-logs/".length)
      const fixtureFetch: typeof fetch = async input => {
        const url = new URL(String(input))
        if (url.searchParams.get("comp") === "list") {
          return new Response(name.startsWith(url.searchParams.get("prefix") ?? "") ? `<Blob><Name>${name}</Name><Metadata><audit_timestamp>${entry.timestamp}</audit_timestamp><audit_entries>1</audit_entries></Metadata></Blob>` : "")
        }
        return url.pathname.endsWith(name) ? new Response(write.body) : new Response(null, { status: 404 })
      }
      vi.stubGlobal("fetch", fixtureFetch)
      try {
        const filter = { tenantId: TENANT, startDate: new Date(Date.parse(entry.timestamp) - 1000), endDate: new Date(Date.parse(entry.timestamp) + 1000) }
        const service = new AuditStorageService({ storageAccountName: "stcontoso", accessToken: "test" })
        const entries = await service.queryAllLogs(filter)
        expect(entries).toHaveLength(1)
        expect((await service.getStats(filter)).totalEvents).toBe(1)
        expect(JSON.parse(auditExportJSON(entries, { tenantId: TENANT, exportedAt: entry.timestamp, pendingCount: 0, filter })).logs[0].job.status).toBe(status)
      } finally { vi.unstubAllGlobals() }
    }
  }, 60_000)

  it.runIf(Boolean(pwsh))("replays a denied audit write and verifies a lost acknowledgement without overwriting", () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-replay.ps1", import.meta.url))
    const result = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 50_000 }))
    expect(result.pending).toBe(1)
    expect(result.replay).toMatchObject({ Count: 0, More: false })
    const entries = Object.entries(result.blobs).filter(([url]) => url.includes("/audit-logs/"))
    expect(entries).toHaveLength(1)
    const entry = JSON.parse(String(entries[0]![1])).entries[0]
    expect(entry.user.id).toBe("22222222-2222-2222-2222-222222222222")
    expect(entry.job).toMatchObject({ runId: "33333333-3333-3333-3333-333333333333", status: "warnings", counts: { saved: 10, failures: 1 } })
    expect(result.calls.filter((call: RunCall) => call.uri.includes("/audit-logs/")).map((call: RunCall) => call.method)).toEqual(["Put", "Get", "Put", "Get"])
    expect(JSON.stringify(result)).not.toContain("secretCanaryAclMessage")
    expect(JSON.stringify(result)).not.toContain("tokenCanary")
  }, 60_000)

  it.runIf(Boolean(pwsh))("counts all recent receipt pages and checkpoints the scan", () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-replay.ps1", import.meta.url))
    const result = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Paged"], { encoding: "utf8", timeout: 50_000 }))
    expect(result.replay).toMatchObject({ Count: 3, More: false, OlderUnchecked: true })
    expect(result.replayAgain).toMatchObject({ Count: 0, More: false, OlderUnchecked: true })
    const lists = (result.calls as RunCall[]).filter(call => call.uri.includes("comp=list"))
    expect(new Set(lists.map(call => new URL(call.uri).searchParams.get("prefix")!).filter(prefix => prefix.startsWith("audit-receipts/"))).size).toBe(14)
    expect(lists.some(call => new URL(call.uri).searchParams.get("marker"))).toBe(true)
    expect((result.calls as RunCall[]).some(call => call.uri.includes("/audit-cursors/"))).toBe(true)
    expect((result.calls as RunCall[]).some(call => call.uri.includes("55555555-5555-5555-5555-555555555555.json"))).toBe(false)
  }, 60_000)

  type RestartRun = Run & { blobs: Record<string, string>; jobErrors: string[] }
  type ParityProbe = "corruptCursor" | "manifest503" | "statusRestart" | "watcherRestart"
  type RestartScenarios = Record<ParityProbe, RestartRun[]> & {
    interrupted: RestartRun[]
    terminalReadDenied: RestartRun
    startDenied: RestartRun
    resultsDenied: RestartRun
    graph401: RestartRun
    auditWriteDenied: RestartRun
    identity: { token: string; calls: number }
    transport: { budgeted: number; unbudgeted: number }
    orphanReplay: { Count: number; More: boolean }
    orphanBlobs: Record<string, string>
    agedStart: { blobs: Record<string, string>; calls: RunCall[]; start: Record<string, string> }
  }
  let restartRuns: RestartScenarios | undefined
  let baselineRuns: Record<ParityProbe, RestartRun[]> | undefined
  const runRestartFixture = (reference?: string) => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-restart.ps1", import.meta.url))
    return JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, ...(reference ? ["-ParityOnly", "-RunbookPath", reference] : [])], {
      encoding: "utf8", timeout: 50_000,
    }))
  }
  const restartCases = () => restartRuns ??= runRestartFixture() as RestartScenarios
  const auditFiles = (run: RestartRun) => Object.entries(run.blobs).filter(([uri]) => uri.includes("/audit-logs/"))
  const manifestFiles = (run: RestartRun) => Object.entries(run.blobs).filter(([uri]) => uri.endsWith("/metadata.json"))
  const outcomeFiles = (run: RestartRun) => Object.entries(run.blobs).filter(([uri]) => uri.includes("/cloud-backup-outcomes/"))
  const statusUri = `${BACKUP_CONTAINER_URL}cloud-backup-status-11111111.json`
  const auditStatus = (run: RestartRun) => {
    const status = JSON.parse(run.blobs[statusUri]!)
    const body = run.blobs[`https://stcontoso.blob.core.windows.net/tenuvault-backup-results/audit-status/${TENANT}/${status.RunId}.json`]
    return body ? JSON.parse(body) : undefined
  }

  it.runIf(Boolean(pwsh))("publishes Schedule status and the watcher note before a stalled terminal audit request", () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-restart.ps1", import.meta.url))
    const { capture, schedule } = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, "-TimingOnly"], {
      encoding: "utf8", timeout: 20_000,
    })) as {
      capture: Run & { graphAtMs: number }
      schedule: Run & { notesAtOtherWrite: number; status: { LastStatus: string; BackupFolder: string } }
    }
    expect(schedule.error).toBeNull()
    expect(schedule.notesAtOtherWrite).toBe(1)
    expect(schedule.status).toEqual({ LastStatus: "Failed", BackupFolder: "backup-other-run" })
    const scheduleWrites = schedule.calls.filter(call => call.method === "Put" && call.uri === statusUri)
    expect(scheduleWrites).toHaveLength(1)
    expect(JSON.parse(scheduleWrites[0]!.body!).LastStatus).toBe("Success")
    const terminal = schedule.calls.findIndex(call => call.method === "Put" && call.uri.endsWith("/terminal.json"))
    const watcherNote = schedule.calls.findIndex(call => call.method === "Put" && call.uri.includes("/cloud-backup-outcomes/"))
    expect(watcherNote).toBeGreaterThanOrEqual(0)
    expect(terminal).toBeGreaterThan(watcherNote)
    expect(capture.error).toBeNull()
    expect(capture.calls.filter(call => call.uri.endsWith("/start.json") && call.method === "Put")).toHaveLength(1)
    expect(capture.graphAtMs).toBeGreaterThanOrEqual(1000)
    expect(capture.graphAtMs).toBeLessThan(5000)
  }, 25_000)

  function comparableRuns(runs: RestartRun[]) {
    const isBackupCall = (uri: string) => {
      const url = new URL(uri)
      return !url.pathname.includes("/audit-") && url.pathname !== "/tenuvault-backup-results"
    }
    const calls = runs.flatMap(run => run.calls.filter(call => isBackupCall(call.uri)))
    const folders = [...new Set(calls.flatMap(call => call.uri.match(/backup-\d{4}-\d{2}-\d{2}-\d{6}/g) ?? []))]
    const ids = [...new Set(calls.filter(call => call.uri.includes("/cloud-backup-outcomes/")).map(call => JSON.parse(call.body!).runId as string))]
    const normalize = (value: string) => {
      folders.forEach((folder, index) => { value = value.replaceAll(folder, `backup-${index + 1}`) })
      ids.forEach((id, index) => { value = value.replaceAll(id, `run-${index + 1}`) })
      return value
    }
    const expectedAuditFields = new Set(["RunId", "AuditCapability", "AuditStatusInResults"])
    const timestamps = new Set(["BackupDate", "StartTime", "EndTime", "Duration", "DurationSeconds", "LastRunAt", "finishedAt"])
    const parseBody = (uri: string, body: string) => JSON.parse(normalize(body), (key, value) => {
      if (key === "RunbookVersion" || (uri === statusUri && expectedAuditFields.has(key))) return undefined
      if (timestamps.has(key)) return typeof value
      return value
    })
    return runs.map(run => ({
      error: run.error && normalize(run.error),
      calls: run.calls.filter(call => isBackupCall(call.uri)).map(call => ({
        ...call, uri: normalize(call.uri), body: call.body && parseBody(call.uri, call.body),
      })),
      blobs: Object.fromEntries(Object.entries(run.blobs).filter(([uri]) => isBackupCall(uri))
        .map(([uri, body]) => [normalize(uri), parseBody(uri, body)])),
    }))
  }

  it.runIf(Boolean(pwsh)).each<ParityProbe>(["corruptCursor", "manifest503", "statusRestart", "watcherRestart"])(
    "matches origin/main backup writes and outcome for %s", probe => {
      const runs = restartCases()[probe]
      const reference = process.env.TENUVAULT_MAIN_RUNBOOK
      if (reference) {
        baselineRuns ??= runRestartFixture(reference) as Record<ParityProbe, RestartRun[]>
        expect(comparableRuns(runs)).toEqual(comparableRuns(baselineRuns[probe]))
      }
      const last = runs.at(-1)!
      const status = JSON.parse(last.blobs[statusUri]!)
      const statusCalls = last.calls.filter(call => call.uri === statusUri)
      expect(statusCalls).toMatchObject([{ method: "Put", condition: null, ifNoneMatch: null }])
      expect(last.calls.filter(call => call.uri.includes("/deviceManagement/deviceCategories")).map(call => call.method)).toEqual(["Get", "Get"])
      expect(last.error).toBe(probe === "manifest503" ? "HTTP 503" : null)
      expect(status.LastStatus).toBe(probe === "manifest503" ? "Failed" : "Success")

      if (probe === "corruptCursor") {
        expect(auditStatus(last).AuditScanIncomplete).toBe(true)
        expect(Object.values(last.blobs)).toContain('{"olderCount":"invalid","days":{}}')
      }
      if (probe === "manifest503") {
        const writes = last.calls.filter(call => call.uri.endsWith("/metadata.json"))
        expect(writes.map(call => [call.method, call.ifNoneMatch, JSON.parse(call.body!).Status])).toEqual([
          ["Put", null, "Success"], ["Put", null, "Success"], ["Put", null, "Success"], ["Put", "*", "Failed"],
        ])
      }
      const notes = outcomeFiles(last).map(([, body]) => JSON.parse(body))
      const manifests = manifestFiles(last).map(([, body]) => JSON.parse(body))
      expect(manifests).toHaveLength(runs.length)
      expect(notes).toHaveLength(runs.length)
      expect(notes).toContainEqual(expect.objectContaining({ runId: status.RunId, status: status.LastStatus }))
      expect(manifests).toContainEqual(expect.objectContaining({ RunId: status.RunId, Status: status.LastStatus }))
      expect(new Set(notes.map(note => note.runId)).size).toBe(runs.length)
      expect(auditFiles(last)).toHaveLength(runs.length)
      if (probe === "statusRestart") {
        expect(JSON.parse(runs[0]!.blobs[statusUri]!).LastStatus).toBe("Failed")
        expect(runs[0]!.calls.filter(call => call.uri === statusUri)).toHaveLength(3)
        expect(notes.map(note => note.status)).toEqual(["Success", "Success"])
      }
      if (probe === "watcherRestart") {
        const [[uri, original]] = outcomeFiles(runs[0]!) as [[string, string]]
        expect(JSON.parse(original).status).toBe("Failed")
        expect(last.blobs[uri]).toBe(original)
      }
    }, 60_000,
  )

  it.runIf(Boolean(pwsh))("records a prior interrupted attempt as uncertain after publishing the restarted job", () => {
    const [first, restarted] = restartCases().interrupted as [RestartRun, RestartRun]
    const prior = JSON.parse(manifestFiles(first)[0]![1])
    const start = first.calls.findIndex(call => call.method === "Put" && call.uri.endsWith("/start.json"))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(start).toBeLessThan(first.calls.findIndex(call => call.uri.includes("graph.microsoft.com")))
    expect(JSON.parse(first.calls[start]!.body!)).toMatchObject({ runId: prior.RunId, folder: prior.BackupFolder })
    expect(restarted.error).toBeNull()
    expect(manifestFiles(restarted)).toHaveLength(2)
    // The only backup container read is the omission policy check every run makes before capture.
    expect(restarted.calls.some(call => call.method === "Get" && call.uri.startsWith(BACKUP_CONTAINER_URL) && !call.uri.includes("/.tenuvault-control/"))).toBe(false)
    const jobs = auditFiles(restarted).map(([, body]) => JSON.parse(body).entries[0].job)
    expect(jobs).toHaveLength(2)
    expect(jobs).toContainEqual(expect.objectContaining({ runId: prior.RunId, status: "uncertain" }))
    const newStatus = JSON.parse(restarted.blobs[statusUri]!)
    expect(newStatus.RunId).not.toBe(prior.RunId)
    expect(jobs).toContainEqual(expect.objectContaining({ runId: newStatus.RunId, status: "completed" }))
    const uncertain = restarted.calls.findIndex(call => call.method === "Put" && call.uri.includes("/audit-logs/") && call.uri.includes(prior.RunId))
    expect(uncertain).toBeGreaterThan(restarted.calls.findIndex(call => call.method === "Put" && call.uri.includes("/cloud-backup-outcomes/")))
  }, 60_000)

  it.runIf(Boolean(pwsh))("keeps capture and Schedule status intact when an audit checkpoint is unavailable", () => {
    for (const run of [restartCases().startDenied, restartCases().terminalReadDenied]) {
      expect(run.error).toBeNull()
      expect(run.calls.some(call => call.uri.includes("graph.microsoft.com"))).toBe(true)
      expect(JSON.parse(run.blobs[statusUri]!)).toMatchObject({ LastStatus: "Success" })
      expect(auditStatus(run)).toMatchObject({ AuditScanIncomplete: true })
      expect(auditFiles(run)).toHaveLength(1)
      expect(JSON.parse(auditFiles(run)[0]![1]).entries[0].job.status).toBe("completed")
    }
  }, 60_000)

  it.runIf(Boolean(pwsh))("records an aged orphan as uncertain using only audit storage", () => {
    const { blobs, calls, start } = restartCases().agedStart
    const published = Object.entries(blobs).filter(([uri]) => uri.includes("/audit-logs/"))
    expect(published).toHaveLength(1)
    expect(JSON.parse(published[0]![1]).entries[0]).toMatchObject({
      id: `${TENANT}-${start.runId}`,
      resource: { id: start.folder }, user: { id: "22222222-2222-2222-2222-222222222222" },
      job: { runId: start.runId, status: "uncertain", trigger: "manual" },
    })
    expect(calls.every(call => !call.uri.startsWith(BACKUP_CONTAINER_URL))).toBe(true)
  }, 60_000)

  it.runIf(Boolean(pwsh))("keeps main transport retries independent of the audit request budget", () => {
    expect(restartCases().identity).toEqual({ token: "token", calls: 3 })
    expect(restartCases().transport).toEqual({ budgeted: 1, unbudgeted: 3 })
  }, 60_000)

  it.runIf(Boolean(pwsh))("reports audit write denial in the error stream and completes the backup", () => {
    const run = restartCases().auditWriteDenied
    expect(run.error).toBeNull()
    expect(run.jobErrors).toContain("Cloud backup audit delivery is pending. The backup result is recorded separately.")
    expect(JSON.parse(run.blobs[statusUri]!)).toMatchObject({ LastStatus: "Success" })
    expect(auditStatus(run)).toMatchObject({ AuditDeliveryPending: true })
    expect(auditFiles(run)).toHaveLength(0)
  }, 60_000)

  it.runIf(Boolean(pwsh))("bounds replay requests and resumes the saved receipt cursor", () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-replay.ps1", import.meta.url))
    const result = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Budgeted"], { encoding: "utf8" }))
    expect(result.firstRequests).toBeLessThanOrEqual(128)
    expect(result.calls.length).toBeLessThanOrEqual(128)
    expect(result.replay).toMatchObject({ More: true, OlderUnchecked: true })
    const lists = (result.calls as RunCall[]).filter(call => call.uri.includes("comp=list"))
    const markers = lists.map(call => Number(new URL(call.uri).searchParams.get("marker")))
    expect(Math.max(...markers)).toBeGreaterThan(150)
    expect(new Set(lists.map(call => new URL(call.uri).searchParams.get("prefix")!).filter(prefix => prefix.startsWith("audit-receipts/"))).size).toBe(14)
  }, 60_000)

  it.runIf(Boolean(pwsh))("retains known undelivered counts outside the automatic UTC window until operator replay", () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-replay.ps1", import.meta.url))
    const result = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Aged"], { encoding: "utf8" }))
    expect(result.replay).toMatchObject({ Count: 1, Older: 0 })
    expect(result.replayAgain).toMatchObject({ Count: 1, Older: 1, OlderUnchecked: true })
    expect(result.operator).toMatchObject({ Count: 0, Older: 0, OlderUnchecked: false })
  }, 60_000)

  it.runIf(Boolean(pwsh))("runs the configured change report and preserves the job result when the audit receipt is denied", () => {
    const run = runPlainFixture()[8]!
    expect(run.error).toBeNull()
    expect(run.output!.join("\n")).toContain("audit receipt could not be saved")
    const body = (fragment: string) => JSON.parse(run.calls.find(call => call.method === "Put" && call.uri.includes(fragment))!.body!)
    expect(body("/metadata.json").Status).toBe("Success")
    expect(body("/cloud-backup-outcomes/").status).toBe("Success")
    const report = run.calls.findIndex(call => call.uri.includes("/intune-backups?") && call.uri.includes("comp=list"))
    const terminal = run.calls.findIndex(call => call.method === "Put" && call.uri.endsWith("/terminal.json"))
    expect(report).toBeGreaterThanOrEqual(0)
    expect(terminal).toBeGreaterThan(report)
    expect(body("/audit-status/").AuditReceiptFailed).toBe(true)
    expect(run.output!.join("\n")).toContain("No earlier complete plain backup")
  }, 60_000)

  it.runIf(Boolean(pwsh))("completes a backup when the results container denies all requests", () => {
    const run = restartCases().resultsDenied
    expect(run.error).toBeNull()
    expect(run.output!.join("\n")).toContain("audit receipt could not be saved")
    expect(JSON.parse(manifestFiles(run)[0]![1]).Status).toBe("Success")
    const status = Object.entries(run.blobs).find(([uri]) => uri.includes("cloud-backup-status-"))![1]
    expect(JSON.parse(status)).toMatchObject({ LastStatus: "Success", AuditStatusInResults: true })
    expect(auditStatus(run)).toBeUndefined()
    expect(outcomeFiles(run)).toHaveLength(0)
  }, 60_000)

  it.runIf(Boolean(pwsh))("ordinary replay recreates the missing receipt from a terminal checkpoint", () => {
    const { orphanReplay, orphanBlobs } = restartCases()
    expect(orphanReplay).toMatchObject({ Count: 0, More: false })
    const rawReceipt = Object.entries(orphanBlobs).find(([uri]) => uri.includes("/audit-receipts/"))?.[1]
    expect(JSON.parse(rawReceipt!)).toMatchObject({ delivered: true, file: { entries: [{ job: { status: "completed" } }] } })
  }, 60_000)

  it.runIf(Boolean(pwsh))("keeps masked OMA values successful outside the audit log", () => {
    const run = runPlainFixture()[7]!
    expect(run.error).toBeNull()
    expect(run.calls.some(call => call.uri.includes("getOmaSettingPlainTextValue"))).toBe(true)
    const body = (fragment: string) => JSON.parse(run.calls.find(call => call.method === "Put" && call.uri.includes(fragment))!.body!)
    expect(body("/metadata.json")).toMatchObject({ Status: "Success", MaskedSecretItems: expect.any(Array), Failures: 0 })
    expect(body("/cloud-backup-status-")).toMatchObject({ LastStatus: "Success" })
    expect(body("/cloud-backup-outcomes/")).toMatchObject({ status: "Success" })
    expect(body("/audit-logs/").entries[0].job).toMatchObject({ status: "warnings", reason: "BACKUP_WARNINGS" })
    expect(run.calls.some(call => call.uri.includes("/intune-backups?") && call.uri.includes("comp=list"))).toBe(true)
  }, 60_000)

  it.runIf(Boolean(pwsh))("reports a Graph policy listing 401 at the correct stage", () => {
    const run = restartCases().graph401
    expect(run.error).toBe("HTTP 401")
    expect(JSON.parse(auditFiles(run)[0]![1]).entries[0].job).toMatchObject({ status: "failed", reason: "GRAPH_LIST_FAILED" })
    expect(run.calls.some(call => call.uri.includes(".tenuvault-owner.json"))).toBe(false)
  }, 60_000)

  it("offers an ARM upgrade that leaves a PowerShell setup's backup writer, variables and schedule in place", () => {
    const resources = template.resources as Array<{ type: string; name: string; condition?: string; dependsOn?: string[] }>
    const audit = resources.filter(resource => resource.name.includes("audit"))
    expect(audit).toHaveLength(3)
    expect(audit.every(resource => resource.condition === "[parameters('enableAudit')]")).toBe(true)
    expect(template.parameters.enableAudit).toMatchObject({ type: "bool", defaultValue: true })
    for (const name of ["auditContainer", "auditCapability"]) {
      expect(template.outputs[name]).toMatchObject({ condition: "[parameters('enableAudit')]" })
    }
    const existingDependencies = resources.filter(resource => !audit.includes(resource)).flatMap(resource => resource.dependsOn ?? [])
    expect(existingDependencies.filter(dependency => /audit/i.test(dependency))).toEqual([])
    const requiredGrants = [
      "[extensionResourceId(resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', parameters('storageAccountName'), 'default', variables('container')), 'Microsoft.Authorization/roleAssignments', guid(variables('containerScope'), parameters('automationAccountName'), variables('writerRoleName')))]",
      "[extensionResourceId(resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', parameters('storageAccountName'), 'default', variables('outcomeContainer')), 'Microsoft.Authorization/roleAssignments', guid(variables('outcomeContainerScope'), parameters('automationAccountName'), variables('writerRoleName')))]",
    ]
    const jobSchedule = "[resourceId('Microsoft.Automation/automationAccounts/jobSchedules', parameters('automationAccountName'), guid(variables('scheduleName'), variables('runbookName')))]"
    for (const resource of audit) {
      expect(resource.dependsOn).toEqual(expect.arrayContaining([...requiredGrants, jobSchedule]))
      if (resource.type !== "Microsoft.Authorization/roleAssignments") expect(resource.dependsOn).toContain("automationVariables")
    }
    expect(resources.filter(resource => !audit.includes(resource)).every(resource => resource.condition?.includes("not(parameters('auditOnly'))"))).toBe(true)
    expect(template.outputs.pasteIntoTenuVault).toMatchObject({ condition: "[not(parameters('auditOnly'))]" })
    expect(template.parameters.auditOnly).toMatchObject({ type: "bool", defaultValue: false })
    expect(template.parameters.scheduleStartTime).not.toHaveProperty("defaultValue")
    expect(template.parameters).not.toHaveProperty("deploySchedule")
    expect(template.parameters).not.toHaveProperty("publishRunbook")
    const main = process.env.TENUVAULT_TEST_MAIN_WORKTREE
    if (main) {
      const base = JSON.parse(readFileSync(join(main, "resources/cloud-backup/azuredeploy.json"), "utf8")) as typeof template
      expect(template.parameters.scheduleStartTime).toEqual(base.parameters.scheduleStartTime)
      const existing = resources.filter(resource => !audit.includes(resource))
      expect(existing.map(({ condition: _condition, ...definition }) => definition)).toEqual(base.resources)
    }
  })

  it.runIf(Boolean(pwsh)).each(["Container", "ReaderContainer", "RoleDefinition", "RoleAssignment"])(
    "preserves standalone storage setup when audit provisioning is denied at %s", (denial) => {
      const script = fileURLToPath(new URL("./fixtures/cloud-backup/storage-audit-denial.ps1", import.meta.url))
      const run = (setupPath?: string) => {
        const output = execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Denial", denial,
          ...(setupPath ? ["-SetupPath", setupPath] : [])], { encoding: "utf8", timeout: 15_000 })
        const { calls } = JSON.parse(output.trim().split(/\r?\n/).at(-1)!) as { calls: string[] }
        return { calls, output, setupCalls: calls.filter(call => !call.startsWith("audit:")) }
      }
      const { calls, output, setupCalls } = run()
      expect(output).toContain("Could not provision audit access")
      expect(output).toContain("create or verify the private 'audit-logs' container")
      expect(output).toContain("Done. In TenuVault")
      expect(setupCalls).toEqual([
        "blob soft delete", "container soft delete", "assign Reader", "assign Storage Blob Data Contributor",
        ...(denial === "Container" ? [] : ["create intune-backups", "assign backup writer", "versioning", "lifecycle"]),
        "final firewall read",
      ])
      if (denial !== "Container") expect(output).toContain("Assign it to the Backup Reader service principal")
      expect(calls.slice(setupCalls.length)).toEqual([
        "audit:container",
        ...(["RoleDefinition", "RoleAssignment"].includes(denial) ? ["audit:definition"] : []),
        ...(denial === "RoleAssignment" ? ["audit:assignment"] : []),
      ])
      const main = process.env.TENUVAULT_TEST_MAIN_WORKTREE
      if (main) expect(setupCalls).toEqual(run(join(main, "resources/New-TenuVaultStorage.ps1")).calls)
    }, 35_000,
  )

  it("bounds the audit setup PowerShell subprocess to one minute", () => {
    const shell = vi.fn(() => "")
    runAuditSetup(shell)
    expect(shell).toHaveBeenCalledWith(pwsh, expect.arrayContaining(["-NoProfile", "-File"]), { encoding: "utf8", timeout: 60_000 })
  })

  it.runIf(Boolean(pwsh))("creates the same audit role on both setup paths and reuses it on rerun", () => {
    const lines = runAuditSetup().trim().split(/\r?\n/)
    const groupScope = "/subscriptions/11111111-1111-1111-1111-111111111111/resourcegroups/rg-audit"
    const bytes = createHash("sha1").update(Buffer.from("11fb06fb712d4ddd98c7e71bbd588830", "hex")).update(groupScope + "-TenuVault Audit Writer").digest()
    bytes[6] = (bytes[6]! & 15) | 80
    bytes[8] = (bytes[8]! & 63) | 128
    const expected = [bytes.subarray(0, 4), bytes.subarray(4, 6), bytes.subarray(6, 8), bytes.subarray(8, 10), bytes.subarray(10, 16)].map(bytes => bytes.toString("hex")).join("-")
    expect(lines).toHaveLength(3)
    for (const line of lines.slice(0, 2)) {
      const run = JSON.parse(line)
      expect(run).toMatchObject({ created: expected, again: expected })
      expect(run.writes).toMatchObject([{ method: "Put", body: { properties: { roleName: `TenuVault Audit Writer ${expected}`, permissions: [{
        actions: [], dataActions: [
          "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
          "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
        ],
      }] } } }])
      expect(run.writes[0].path).toContain(`/roleDefinitions/${expected}?`)
    }
    const assignment = JSON.parse(lines[2]!)
    expect(Object.keys(assignment.grants)).toHaveLength(3)
    expect(assignment.writes.map((write: { body: { properties: { principalId: string } } }) => write.body.properties.principalId)).toEqual([
      "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444",
    ])
    const sameGroup = assignment.writes[2]
    const key = `microsoft.storage/storageaccounts/stcontoso/blobservices/default/containers/audit-logs-same-auto-account-name-TenuVault Audit Writer ${expected}`
    const id = createHash("sha1").update(Buffer.from("11fb06fb712d4ddd98c7e71bbd588830", "hex")).update(key).digest()
    id[6] = (id[6]! & 15) | 80
    id[8] = (id[8]! & 63) | 128
    const guid = id.toString("hex").slice(0, 32).replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5")
    expect(sameGroup.path).toContain(`/roleAssignments/${guid}?`)
    expect(template.variables.auditAssignmentId).toBe("[guid(toLower(variables('auditContainerScope')), toLower(parameters('automationAccountName')), variables('auditRoleName'))]")
  }, auditSetupTimeout)

  it("describes cloud audit records by runbook version in the history and replay sections", () => {
    const guide = readFileSync(new URL("../docs-site/src/content/docs/backups/cloud.md", import.meta.url), "utf8")
    expect(guide).toMatch(/Audit Log.*starting with runbook 1\.5\.0/)
    expect(guide).not.toMatch(/audit log.*gets no entries/i)
    expect(guide).toContain("the latest run's audit delivery health")
  })

  it("provisions private audit storage with container-scoped read and add only in both setup paths", () => {
    const resources = template.resources as Array<{ type: string; name?: string; scope?: string; properties: Record<string, unknown> }>
    const role = resources.find(resource => resource.type.endsWith("/roleDefinitions") && resource.name?.includes("auditRoleId"))
    expect(role?.properties.permissions).toMatchObject([{ actions: [], dataActions: [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
    ] }])
    expect(resources.find(resource => resource.type.endsWith("/containers") && resource.name?.includes("auditContainer"))?.properties.publicAccess).toBe("None")
    expect(resources.find(resource => resource.type.endsWith("/roleAssignments") && resource.name?.includes("auditAssignmentId"))?.scope).toContain("variables('auditContainer')")
    const readerSetup = readFileSync(new URL("../resources/New-TenuVaultStorage.ps1", import.meta.url), "utf8")
    for (const script of [setup, readerSetup]) {
      expect(script).toContain('$auditContainer = "audit-logs"')
      const definition = script.slice(script.indexOf("function Get-TenuVaultAuditRole"), script.indexOf("return [pscustomobject]@{ Id = $definitionId; Name = $name }"))
      expect(definition).toContain("blobs/add/action")
      expect(definition).not.toMatch(/blobs\/(?:write|delete)/)
      expect(script).toContain("/blobServices/default/containers/$auditContainer")
    }
    expect(runbook).not.toMatch(/-Method\s+"Delete"/i)
  })
})

describe("Invoke-TenuVaultBackup.ps1 type table", () => {
  it("covers every desktop registry type with the same folder, path and read shape", () => {
    for (const type of INTUNE_TYPES) {
      const row = runbook.split("\n").find((line) => line.includes(`Folder = '${type.folder}'`))
      expect(row, type.folder).toBeTruthy()
      expect(row).toContain(`Path = '${type.path}'`)
      expect(row).toContain(`NameKey = '${type.nameKey}'`)
      expect(row).toContain(type.expand ? `Expand = '${type.expand}'` : "Expand = $null")
      expect(row).toContain(type.select ? `Select = '${type.select}'` : "Select = $null")
      expect(row).toContain(type.listQuery ? `ListQuery = '${type.listQuery}'` : "ListQuery = $null")
      expect(row).toContain(`AssignmentsFormerlyExpanded = $${type.assignmentsFormerlyExpanded === true ? "true" : "false"}`)
      if (type.listOnly) expect(row).toContain("ListOnly = $true")
      else expect(row).not.toContain("ListOnly")
      if (type.inventory) expect(row).toContain("Inventory = $true")
      else expect(row).not.toContain("Inventory")
      if (type.keep) expect(row).toContain(`Keep = @(${type.keep.map((key) => `'${key}'`).join(",")})`)
      else expect(row).not.toContain("Keep =")
      for (const extra of type.extras ?? []) {
        expect(row, `${type.folder}/${extra.property}`).toContain(`Property = '${extra.property}'`)
        expect(row).toContain(`Template = '${extra.path("{id}")}'`)
        if (extra.each) expect(row).toContain(`Template = '${extra.each.path("{id}", "{entryId}")}'`)
      }
    }
    expect([...runbook.matchAll(/Folder = '/g)]).toHaveLength(INTUNE_TYPES.length)
  })

  it("mirrors the singleton, the built-in skips and the masked OMA-URI rule", () => {
    const singleton = INTUNE_TYPES.find((type) => type.singleton)!
    expect(singleton.singleton?.id).toBe(COMPLIANCE_SETTINGS_ID)
    for (const key of COMPLIANCE_SETTING_KEYS) expect(runbook).toContain(`'${key}'`)
    for (const skipped of ["Remediations", "AppCategories", "ScopeTags", "RoleDefinitions"]) {
      expect(runbook).toContain(`"${skipped}"`)
      expect(INTUNE_TYPES.find((type) => type.folder === skipped)?.skip).toBeTypeOf("function")
    }
    expect(runbook).toContain("getOmaSettingPlainTextValue")
    expect(runbook).toContain('Set-TvProp $setting "value" "****"')
    expect(runbook).toContain("MaskedSecretItems")
  })
})

describe("Invoke-TenuVaultBackup.ps1 format", () => {
  it("writes plain JSON and never reads Key Vault or the recovery key", () => {
    // The legacy envelope is only recognised, so a sealed earlier backup is skipped, never opened.
    expect(runbook.match(/"TVAZ1`n"/g)).toHaveLength(1)
    expect(runbook).toMatch(/function Test-TvSealedBlob \{[^}]*"TVAZ1`n"/)
    for (const sealing of ["HKDF", "AesGcm", "Decrypt(", "tenuvault-azure-backup-v1", "tenuvault-recovery-key", "vault.azure.net", "application/octet-stream"]) {
      expect(runbook, sealing).not.toContain(sealing)
    }
    expect(runbook).not.toMatch(/Get-TvRequiredVariable "TenuVaultKeyVault"/)
    expect(runbook).not.toMatch(/Set-TvSealedBlob|Protect-TvAzureBlob|Get-TvRecoveryMasterKey/)
    // Every backup container write goes through one helper, as JSON.
    expect(runbook.match(/Invoke-TvHttp -Uri \$target\.Uri -Token \$Token -Method "Put"/g)).toHaveLength(1)
    expect(runbook).toContain('-BodyBytes ([Text.Encoding]::UTF8.GetBytes($Body)) -ContentType "application/json"')
    expect(runbook).toContain('headers["If-None-Match"] = "*"')
  })

  it("carries a plain runbook version, which the app does not flag for upgrade", () => {
    const version = RUNBOOK_VERSION
    // 1.3.0 adds change reports on top of the first plain runbook, 1.2.0; 1.4.0 records how a run started.
    expect(version).toBe("1.6.0")
    expect(PLAIN_CLOUD_RUNBOOK).toBe("1.2.0")
    expect(cloudRunbookNeedsUpgrade(version!)).toBe(false)
    expect(cloudRunbookNeedsUpgrade("1.1.0")).toBe(true)
    expect(cloudRunbookNeedsUpgrade("1.0.0")).toBe(true)
    expect(cloudRunbookNeedsUpgrade("0.9.9")).toBe(true)
    expect(cloudRunbookNeedsUpgrade("1.10.0")).toBe(false)
    expect(cloudRunbookNeedsUpgrade("2.0.0")).toBe(false)
    expect(cloudRunbookNeedsUpgrade("")).toBe(false)
    expect(cloudRunbookNeedsUpgrade("desktop")).toBe(false)
  })

  it.runIf(Boolean(pwsh))("records a run as manual only with TRIGGER Manual, and every other run as scheduled", () => {
    const path = fileURLToPath(new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url))
    // The value is passed as the runbook's own TRIGGER parameter, as the portal's Start pane does.
    const trigger = (value: string | null) => JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-Command", [
      `. '${path.replace(/'/g, "''")}' -LibraryOnly${value === null ? "" : ` -Trigger '${value}'`}`,
      "[Console]::Out.Write((ConvertTo-Json -Compress (Get-TvRunTrigger $Trigger)))",
    ].join("\n")], { encoding: "utf8", timeout: 60_000 })) as { Trigger: string; Warning: string | null }
    // Omitted or empty, as every schedule link starts it: scheduled, exactly as before.
    expect(trigger(null)).toEqual({ Trigger: "scheduled", Warning: null })
    expect(trigger("")).toEqual({ Trigger: "scheduled", Warning: null })
    expect(trigger("Manual")).toEqual({ Trigger: "manual", Warning: null })
    expect(trigger("manual")).toEqual({ Trigger: "manual", Warning: null })
    expect(trigger("Scheduled")).toEqual({ Trigger: "scheduled", Warning: null })
    expect(trigger("Nightly")).toEqual({ Trigger: "scheduled", Warning: "Warning: TRIGGER 'Nightly' is neither Manual nor Scheduled, so this run is recorded as scheduled. Set TRIGGER to Manual for a run started by hand, or leave it empty." })
    // The schedule link passes only TENANTKEY; TRIGGER is optional with an empty default.
    expect(runbook).toContain('    [string]$TenantKey = "",')
    expect(runbook).toContain('    [string]$Trigger = "",')
    expect(runbook).toContain("$runInfo = Get-TvRunTrigger $Trigger")
    expect(runbook.match(/Trigger += \$runTrigger|Trigger = \$runTrigger/g)).toHaveLength(2)
    expect(runbook).toContain("-RunTrigger $runTrigger")
    expect(runbook).not.toContain('Trigger        = "scheduled"')
    expect(runbook).not.toMatch(/startedBy"|TenuVaultAutomationAccountId|management\.azure\.com/)
  }, 60_000)

  it.runIf(Boolean(pwsh))("writes the trigger into the backup's metadata, with a warning line for an invalid value, and never fails the backup", () => {
    const runs = runPlainFixture()
    const trigger = (run: Run) => JSON.parse(run.calls.find((call) => call.method === "Put" && call.uri.endsWith("/metadata.json"))!.body!).Trigger
    expect(trigger(runs[0]!)).toBe("scheduled")
    const [manual, invalid] = [runs[5]!, runs[6]!]
    expect(manual.error).toBeNull()
    expect(trigger(manual)).toBe("manual")
    expect(manual.output!.some((line) => line.startsWith("Warning: TRIGGER"))).toBe(false)
    expect(invalid.error).toBeNull()
    expect(trigger(invalid)).toBe("scheduled")
    expect(invalid.output!.filter((line) => line.startsWith("Warning: TRIGGER 'Nightly'"))).toHaveLength(1)
    // The result note for the watcher carries the same trigger, so its alert names a run started by hand.
    const note = (run: Run) => JSON.parse(run.calls.find((call) => call.method === "Put" && call.uri.includes("/cloud-backup-outcomes/"))!.body!).trigger
    expect(note(runs[0]!)).toBe("scheduled")
    expect(note(manual)).toBe("manual")
    expect(note(invalid)).toBe("scheduled")
    // Early failures carry the trigger into the note as well.
    for (const earlyFailure of runs.slice(1, 3)) expect(note(earlyFailure)).toBe("scheduled")
  }, 60_000)

  it.runIf(Boolean(pwsh))("never lets the optional change report fail a backup, and says when a backup with warnings gets none", () => {
    const [, , , reportFails, warnings] = runPlainFixture()
    // The report step meets an unexpected error: the backup is still recorded as a success.
    expect(reportFails!.error).toBeNull()
    expect(reportFails!.output).toContain("No change report was made: storage listing is unavailable")
    const status = reportFails!.calls.filter((call) => call.method === "Put" && call.uri.endsWith("/cloud-backup-status-11111111.json")).map((call) => JSON.parse(call.body!).LastStatus)
    expect(status).toEqual(["Success"])
    // A backup with warnings gets no report, and the job output says so.
    expect(warnings!.error).toBeNull()
    expect(warnings!.output).toContain("No change report: the backup completed with warnings.")
    expect(warnings!.calls.some((call) => call.uri.includes("/intune-backups?") && call.uri.includes("comp=list"))).toBe(false)
  }, 60_000)

  it.runIf(Boolean(pwsh))("puts only plain JSON blobs during a run, records early failures and never calls Key Vault", () => {
    const [run, failed, claimed] = runPlainFixture()
    for (const scenario of [run!, failed!, claimed!]) {
      expect(scenario.calls.some((call) => call.uri.includes("vault.azure.net"))).toBe(false)
      const puts = scenario.calls.filter((call) => call.method === "Put")
      expect(puts.length).toBeGreaterThan(0)
      for (const put of puts) {
        expect(put.contentType, put.uri).toBe("application/json")
        expect(put.body!.startsWith("TVAZ1")).toBe(false)
        expect(() => JSON.parse(put.body!), put.uri).not.toThrow()
      }
    }
    const puts = run!.calls.filter((call) => call.method === "Put" && !call.uri.includes("/.tenuvault-control/"))
    const backup = "https://stcontoso.blob.core.windows.net/intune-backups/"
    const names = puts.map((call) => call.uri.replace(/backup-\d{4}-\d{2}-\d{2}-\d{6}/, "backup-<time>"))
    expect(names).toEqual(expect.arrayContaining([
      `${backup}backup-<time>/.tenuvault-owner.json`,
      `${backup}backup-<time>/DeviceConfigurations/Baseline%20Wi-Fi.json`,
      `${backup}backup-<time>/metadata.json`,
      `${backup}cloud-backup-status-11111111.json`,
    ]))
    // The claim comes first and is create-only; the policy file is the Graph object as read.
    expect(names.find((name) => name.startsWith(backup))).toBe(`${backup}backup-<time>/.tenuvault-owner.json`)
    expect(puts.find((call) => call.uri.startsWith(backup))!.ifNoneMatch).toBe("*")
    const policy = JSON.parse(puts.find((call) => call.uri.includes("/DeviceConfigurations/"))!.body!)
    expect(policy).toMatchObject({ id: "cfg-1", displayName: "Baseline Wi-Fi" })
    expect(policy["@odata.context"]).toBeUndefined()
    const metadata = JSON.parse(puts.find((call) => call.uri.endsWith("/metadata.json"))!.body!)
    expect(metadata).toMatchObject({ Status: "Success", RunbookVersion: RUNBOOK_VERSION, Source: "TenuVault Cloud Backup", TenantId: "11111111-2222-3333-4444-555555555555" })
    const status = JSON.parse(puts.find((call) => call.uri.endsWith("/cloud-backup-status-11111111.json"))!.body!)
    expect(parseCloudStatus(status, "11111111-2222-3333-4444-555555555555")).toMatchObject({ lastStatus: "Success", runbookVersion: RUNBOOK_VERSION })
    // A run that fails before any backup write still records why, in the status blob and the note.
    expect(failed!.error).toContain("managed identity token")
    const failedStatus = failed!.calls.find((call) => call.method === "Put" && call.uri.endsWith("/cloud-backup-status-11111111.json"))
    expect(parseCloudStatus(JSON.parse(failedStatus!.body!), "11111111-2222-3333-4444-555555555555")).toMatchObject({ lastStatus: "Failed" })
    expect(failed!.calls.some((call) => call.method === "Put" && call.uri.includes("/tenuvault-backup-results/cloud-backup-outcomes/run-"))).toBe(true)
    expect(failed!.calls.some((call) => call.uri.includes("/intune-backups/backup-"))).toBe(false)
  }, 60_000)

  it.runIf(Boolean(pwsh))("uses the existing storage identity to omit credentials and stops on an enrolled policy read failure", () => {
    const runs = runPlainFixture()
    const [active, missing, graphError] = ["on", "missing", "graphError"].map(name => runs.find(run => run.scenario === name)!)
    const blobs = writtenBlobs(active!)
    const folder = folderOf(blobs)
    const projected = blobs.get(`${folder}/.omitted/DeviceConfigurations/Baseline Wi-Fi.json`)!
    const manifest = JSON.parse(blobs.get(`${folder}/metadata.json`)!)
    expect(manifest).toMatchObject({ OmissionEnabled: true, OmissionVersion: 1, OmissionPolicyGeneration: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", SkippedTypes: ["DeviceConfigurations"], ActualSkippedTypes: [] })
    expect(verifyProjectedSnapshot(projected, { ...manifest.Items["DeviceConfigurations/cfg-1"], id: "cfg-1" })).toHaveProperty("displayName", "Baseline Wi-Fi")
    expect(blobs.has(`${folder}/DeviceConfigurations/Baseline Wi-Fi.json`)).toBe(false)
    const completedAudit = active!.calls.find(call => call.method === "Put" && call.uri.includes("/audit-logs/"))
    expect(JSON.parse(completedAudit!.body!).entries[0].job).toMatchObject({ status: "warnings", reason: "BACKUP_VALUES_OMITTED" })
    expect(manifest.Status).toBe("Success")
    expect(JSON.stringify([active, missing, graphError])).not.toMatch(/omission-test-value|omission-test-secret-reference|getOmaSettingPlainTextValue/)
    expect(missing!.error).toContain("omission policy could not be verified")
    const audit = missing!.calls.find(call => call.method === "Put" && call.uri.includes("/audit-logs/"))
    expect(JSON.parse(audit!.body!).entries[0].job).toMatchObject({ status: "failed", reason: "OMISSION_POLICY_UNVERIFIED" })
    expect(missing!.calls.some(({ uri }) => uri.startsWith("https://graph.microsoft.com") || uri.includes("/intune-backups/backup-"))).toBe(false)
  }, 60_000)

  it.runIf(Boolean(pwsh))("records the starting mode, streams partial backups and writes to immutable storage", () => {
    const runs = runPlainFixture()
    const startingOff = runs.find(run => run.scenario === "modeChanged")!
    expect(startingOff.error).toBeNull()
    const inFlight = writtenBlobs(startingOff)
    expect(JSON.parse(inFlight.get(`${folderOf(inFlight)}/metadata.json`)!)).toMatchObject({ OmissionEnabled: false, OmissionPolicyGeneration: "default" })
    expect(startingOff.calls.filter(call => call.uri.endsWith("secret-omission.json")).map(call => call.method)).toEqual(["Get"])
    const interrupted = runs[2]!
    const saved = interrupted.calls.findIndex(call => call.method === "Put" && call.uri.endsWith("/DeviceConfigurations/First.json"))
    expect(saved).toBeGreaterThan(-1)
    expect(saved).toBeLessThan(interrupted.calls.findIndex(call => call.method === "Get" && call.uri.includes("/deviceConfigurations/cfg-1")))
    expect(JSON.parse([...writtenBlobs(interrupted)].find(([path]) => path.endsWith("metadata.json"))![1])).toMatchObject({ Status: "Failed", ItemCounts: { DeviceConfigurations: 1 } })
    for (const name of ["immutable1", "immutable2"]) {
      const immutable = runs.find(run => run.scenario === name)!
      expect(immutable.error).toBeNull()
      expect(immutable.calls.some(call => call.method === "Put" && call.uri.endsWith("/metadata.json"))).toBe(true)
      expect(immutable.calls.every(call => !call.uri.includes(".blob.core.windows.net") || call.uri.startsWith("https://stcontoso."))).toBe(true)
    }
  }, 60_000)

  it.runIf(Boolean(pwsh))("saves a list-only type from its list entry, with the desktop snapshot and fingerprint", () => {
    const [run] = runPlainFixture()
    // No detail GET for the device: the list entry is the snapshot.
    expect(run!.calls.some((call) => call.uri.includes("windowsAutopilotDeviceIdentities/"))).toBe(false)
    const type = typeForFolder("AutopilotDevices")!
    const listed = { id: "ap-1", serialNumber: "SN-0001", manufacturer: "Contoso", model: "Laptop 7", groupTag: "Sales", displayName: null, userPrincipalName: "", lastContactedDateTime: "2026-11-01T10:00:00Z", enrollmentState: "enrolled", deviceAccountPassword: "secret", productKey: "PK-1", managedDeviceId: "md-1" }
    const expected = listSnapshot(type, listed)
    const put = run!.calls.find((call) => call.method === "Put" && call.uri.includes("/AutopilotDevices/"))!
    expect(put.uri).toContain("/AutopilotDevices/SN-0001.json")
    const saved = JSON.parse(put.body!)
    expect(saved).toEqual(expected)
    for (const left of ["deviceAccountPassword", "productKey", "managedDeviceId", "lastContactedDateTime", "enrollmentState"]) expect(saved).not.toHaveProperty(left)
    const metadata = JSON.parse(run!.calls.find((call) => call.method === "Put" && call.uri.endsWith("/metadata.json"))!.body!)
    const desktopHash = createHash("sha256").update(JSON.stringify(comparableSnapshot(expected))).digest("base64").slice(0, 22)
    expect(metadata.Items["AutopilotDevices/ap-1"].hash).toBe(desktopHash)
    // Devices are counted under their own folder, not as policies.
    expect(metadata.ItemCounts).toMatchObject({ AutopilotDevices: 1, DeviceConfigurations: 1, CompliancePolicySettings: 1, TotalPolicies: 2 })
  }, 60_000)

  it.runIf(Boolean(pwsh))("leaves the tenant evidence the app's ownership check needs, in complete, failed and in-flight backups", async () => {
    const [run, , claimed] = runPlainFixture()
    for (const scenario of [run!, claimed!]) {
      const blobs = writtenBlobs(scenario)
      const folder = folderOf(blobs)
      const manifest = JSON.parse(blobs.get(`${folder}/metadata.json`)!)
      const marker = JSON.parse(blobs.get(`${folder}/${BACKUP_OWNER_FILE}`)!)
      expect(typeof manifest.TenantId).toBe("string")
      expect(typeof marker.TenantId).toBe("string")
      expect(manifest.RunId).toBe(marker.RunId)
      // Restore, revert and recreate go through this check: owned by the manifest's tenant, refused for any other.
      const owned = await readOwnedBackup(read(blobs), folder, TENANT.toUpperCase(), "stcontoso")
      expect(owned).toMatchObject({ ok: true, owned: true, metadata: { TenantId: TENANT, Source: "TenuVault Cloud Backup" } })
      expect(await readOwnedBackup(read(blobs), folder, "99999999-2222-3333-4444-555555555555", "stcontoso")).toEqual({ ok: false, status: 403, error: OTHER_TENANT_BACKUP })
      const resolved = await resolveBackupOwnership(async (file) => {
        const body = blobs.get(`${folder}/${file}`)
        return body === undefined ? { kind: "missing" } : { kind: "found", value: JSON.parse(body) }
      }, TENANT)
      expect(resolved.owner).toMatchObject({ kind: "owned", source: "manifest", tenantId: TENANT, runId: manifest.RunId })
    }
    expect(JSON.parse(writtenBlobs(claimed!).get(`${folderOf(writtenBlobs(claimed!))}/metadata.json`)!)).toMatchObject({ Status: "Failed", Error: "HTTP 401" })
    // While a run is still writing, before metadata.json exists, the claim alone places the folder.
    const inFlight = writtenBlobs(run!)
    const folder = folderOf(inFlight)
    inFlight.delete(`${folder}/metadata.json`)
    const resolved = await resolveBackupOwnership(async (file) => {
      const body = inFlight.get(`${folder}/${file}`)
      return body === undefined ? { kind: "missing" } : { kind: "found", value: JSON.parse(body) }
    }, TENANT)
    expect(resolved.owner).toMatchObject({ kind: "owned", source: "marker", tenantId: TENANT })
    expect(await readOwnedBackup(read(inFlight), folder, TENANT, "stcontoso")).toMatchObject({ ok: true, owned: true, metadata: null })
  }, 60_000)

  it("writes the desktop manifest shape and the per tenant status blob", () => {
    for (const field of ["BackupDate", "BackupFolder", "StartTime", "EndTime", "Duration", "DurationSeconds", "ItemCounts", "Status", "RunbookVersion", "BackupFormat", "Source", "TenantId", "Trigger", "RunId", "Scope", "Failures", "SkippedTypes", "FailedTypes", "AuthMode", "Items"]) {
      expect(runbook, field).toContain(field)
    }
    expect(runbook).toContain('"TenuVault Cloud Backup"')
    expect(runbook).toContain(".tenuvault-owner.json")
    expect(cloudStatusBlobName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("cloud-backup-status-aaaaaaaa.json")
    expect(runbook).toContain('$script:StatusBlobPrefix = "cloud-backup-status-"')
  })

  it("hashes with the desktop parser and ordinal key order, not ConvertFrom-Json dates or culture sort", () => {
    expect(runbook).toContain("System.Text.Json.JsonDocument")
    expect(runbook).toContain("[StringComparer]::Ordinal")
  })

  it("reads with a managed identity and deletes nothing", () => {
    expect(runbook).toContain("IDENTITY_ENDPOINT")
    expect(runbook).toContain("https://graph.microsoft.com/beta")
    expect(runbook).not.toMatch(/Method\s+"(Delete|Post|Patch)"/)
    expect(runbook).not.toMatch(/Get-AutomationVariable -Name \$Name/)
  })
})

type SetupScenario = {
  scenario: string; plain: boolean; reason: string | null; error: string | null; actions: string[]; legacyVariableKept: boolean
  changeReport?: string | null; changeReportActors?: string | null; tenantName?: string | null; variables: string[]
  schedule: boolean; link: boolean; output: string[]; omissionBinding: string | null; storageAccount: string | null; scope?: string | null
}
let setupScenarios: Map<string, SetupScenario> | undefined
function setupRun(name: string): SetupScenario {
  if (!setupScenarios) {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/setup-upgrade.ps1", import.meta.url))
    const lines = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 120_000 })
      .split(/\r?\n/).filter(line => line.startsWith("{"))
    setupScenarios = new Map(lines.map(line => JSON.parse(line) as SetupScenario).map(run => [run.scenario, run]))
  }
  return setupScenarios.get(name)!
}

it.runIf(Boolean(pwsh))("copies policies on a best-effort basis and allows cloud storage moves and fresh installs", () => {
  expect(setupRun("move-copies-policy")).toMatchObject({ error: null, storageAccount: "stcontoso", omissionBinding: "stprevious,stcontoso", actions: expect.arrayContaining(["copy-policy"]) })
  expect(setupRun("move-copies-off")).toMatchObject({ error: null, storageAccount: "stcontoso", omissionBinding: "stprevious", actions: expect.arrayContaining(["copy-policy"]) })
  expect(setupRun("move-warns-on-denied")).toMatchObject({ error: null, storageAccount: "stcontoso", omissionBinding: "stprevious", output: expect.arrayContaining([expect.stringContaining("Verify the omission setting")]) })
  expect(setupRun("move-quiet-on-denied")).toMatchObject({ error: null, storageAccount: "stcontoso" })
  expect(setupRun("move-quiet-on-denied").output.join(" ")).not.toContain("Verify the omission setting")
  expect(setupRun("move-continues-on-list-error")).toMatchObject({ error: null, storageAccount: "stcontoso", omissionBinding: "stprevious" })
  for (const [scenario, binding] of [["move-keeps-destination", "stprevious,stcontoso"], ["move-keeps-off", "stprevious"]] as const) {
    expect(setupRun(scenario)).toMatchObject({ error: null, storageAccount: "stcontoso", omissionBinding: binding,
      output: expect.arrayContaining([expect.stringContaining("Keeping the omission policy already set")]),
    })
    expect(setupRun(scenario).actions).not.toContain("copy-policy")
  }
  expect(setupRun("fresh-recovers-after-list-error")).toMatchObject({ error: null, storageAccount: "stcontoso", omissionBinding: "", plain: true })
  expect(setupRun("fresh-continues-on-list-error")).toMatchObject({ error: null, storageAccount: "stcontoso", omissionBinding: null, plain: true })
  expect(setupRun("upgrade-preserves-binding").omissionBinding).toBe("stprevious")
  expect(setupRun("upgrade-creates-binding").omissionBinding).toBe("")
  const denied = setupRun("upgrade-binding-denied")
  expect(denied).toMatchObject({ error: null, storageAccount: "stcontoso", scope: "policies", omissionBinding: null })
  expect(denied.output.join("\n")).toContain("could not be written")
  expect(setupRun("upgrade-keeps-unreadable-binding").omissionBinding).toBe("stprevious")
}, 130_000)

it("adds no migration resources to the default ARM deployment", () => {
  expect(template.parameters.omissionMigrationIdentityId).toMatchObject({ defaultValue: "" })
  expect(template.parameters.initializeOmissionEnrollment).toMatchObject({ defaultValue: false })
  const migration = template.resources.find(resource => resource.type === "Microsoft.Resources/deploymentScripts")
  expect(migration?.condition).toBe("[and(not(parameters('auditOnly')), not(empty(parameters('omissionMigrationIdentityId'))))]")
  const defaultResources = template.resources.filter(resource =>
    !resource.condition?.includes("omissionMigrationIdentityId") &&
    !resource.condition?.includes("initializeOmissionEnrollment"))
  expect(defaultResources.map(resource => resource.type)).toEqual([
    "Microsoft.Automation/automationAccounts",
    "Microsoft.Authorization/roleDefinitions",
    "Microsoft.Authorization/roleAssignments",
    "Microsoft.Storage/storageAccounts/blobServices/containers",
    "Microsoft.Authorization/roleAssignments",
    "Microsoft.Authorization/roleDefinitions",
    "Microsoft.Storage/storageAccounts/blobServices/containers",
    "Microsoft.Authorization/roleAssignments",
    "Microsoft.Automation/automationAccounts/runbooks",
    "Microsoft.Automation/automationAccounts/variables",
    "Microsoft.Automation/automationAccounts/schedules",
    "Microsoft.Automation/automationAccounts/jobSchedules",
  ])
})

it("includes the initialization parameter in the Deploy to Azure instructions", () => {
  const docs = readFileSync(new URL("../docs-site/src/content/docs/backups/cloud.md", import.meta.url), "utf8")
  expect(docs.split("### Deploy to Azure")[1]?.split("### Test it now")[0]).toContain("`initializeOmissionEnrollment`")
})

it.runIf(process.platform !== "win32" && spawnSync("jq", ["--version"]).status === 0)("allows an ARM storage move when optional migration cannot copy or finds an off policy", () => {
  const migration = template.resources.find(resource => resource.type === "Microsoft.Resources/deploymentScripts")!
  expect(migration.properties?.scriptContent).toContain("--if-none-match '*'")
  expect(template.outputs).toHaveProperty("omissionPolicyMigration")
  expect(template.resources.find(resource => resource.type === "Microsoft.Automation/automationAccounts/variables" && !resource.condition?.includes("initializeOmissionEnrollment"))?.dependsOn)
    .toContain("[resourceId('Microsoft.Resources/deploymentScripts', variables('omissionMigrationName'))]")
  const schedules = template.resources.find(resource => resource.type === "Microsoft.Automation/automationAccounts/schedules")!
  // The schedule keeps main's dependencies, so optional omission provisioning never holds it back.
  expect(schedules.dependsOn).toEqual(["[resourceId('Microsoft.Automation/automationAccounts', parameters('automationAccountName'))]"])
  const dir = mkdtempSync(join(tmpdir(), "tv-omission-arm-"))
  const output = join(dir, "output.json")
  const az = `az() {
    if [ "$1" = rest ]; then
      if [ -z "$VARIABLES" ]; then return 1; fi
      printf '%s' "$VARIABLES"
    elif [ "$3" = download ]; then
      shift 3
      while [ "$#" -gt 1 ]; do
        case "$1" in
          --account-name) account=$2 ;;
          --file) file=$2 ;;
        esac
        shift
      done
      if [ "$account" = newacct ] && [ -n "$DESTINATION_POLICY" ]; then printf '%s' "$DESTINATION_POLICY" > "$file"; else return 1; fi
    else
      return 1
    fi
  }
  `
  const variables = (binding: string) => JSON.stringify({ value: [
    { name: "TenuVaultOmissionAccount-11111111", properties: { value: JSON.stringify(binding) } },
    { name: "TenuVaultStorageAccount-11111111", properties: { value: '"oldacct"' } },
  ] })
  const run = (binding: string | undefined, enabled?: boolean) => spawnSync("/bin/bash", ["-c", az + migration.properties!.scriptContent!], {
    encoding: "utf8", env: { ...process.env,
      AZ_SCRIPTS_OUTPUT_PATH: output, AUTOMATION_ID: "/mock", TENANT_KEY: "11111111", TENANT_ID: TENANT,
      NEW_ACCOUNT: "newacct", VARIABLES: binding === undefined ? "" : variables(binding),
      DESTINATION_POLICY: enabled === undefined ? "" : JSON.stringify({ version: 1, tenantId: TENANT, enabled, scripts: false, generation: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
    },
  })
  try {
    const enrolled = run("oldacct")
    expect(enrolled.status).toBe(0)
    expect(enrolled.stderr).toContain("Verify the omission setting")
    expect(JSON.parse(readFileSync(output, "utf8")).message).toContain("Verify the omission setting")
    const neverEnrolled = run("")
    expect(neverEnrolled.status).toBe(0)
    expect(neverEnrolled.stderr).toBe("")
    for (const enabled of [false, true]) {
      const keepsPolicy = run("oldacct", enabled)
      expect(keepsPolicy.status).toBe(0)
      expect(keepsPolicy.stderr).toBe("")
      expect(JSON.parse(readFileSync(output, "utf8")).message).toContain("Keeping the omission policy")
    }
    const listingFailed = run(undefined)
    expect(listingFailed.status).toBe(0)
    expect(listingFailed.stderr).toBe("")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("New-TenuVaultCloudBackup.ps1", () => {
  it("grants only the read roles, behind the same device inventory decision", () => {
    for (const role of ["DeviceManagementConfiguration.Read.All", "DeviceManagementApps.Read.All", "DeviceManagementServiceConfig.Read.All", "DeviceManagementScripts.Read.All", "DeviceManagementRBAC.Read.All"]) {
      expect(setup).toContain(`"${role}"`)
    }
    expect(setup).toContain('if ($IncludeDeviceCategories) { $graphRoleNames += "DeviceManagementManagedDevices.Read.All" }')
    // AppRoleAssignment.ReadWrite.All is the Global Administrator's own delegated scope for
    // granting; no DeviceManagement write role may ever be assigned to the identity.
    expect(setup).not.toMatch(/DeviceManagement\w*\.ReadWrite/)
    expect(setup).toContain("DeviceCategories,DeviceCleanupRules")
  })

  it("links the schedule with TENANTKEY only and grants no role on the Automation account", () => {
    // The link is registered as on main: only TENANTKEY, which every runbook version accepts.
    expect(setup).toContain("-ScheduleName $scheduleName -Parameters @{ TenantKey = $tenantKey } | Out-Null")
    expect(setup.match(/Register-AzAutomationScheduledRunbook/g)).toHaveLength(1)
    expect(setup).not.toMatch(/Trigger\s*=|TenuVaultScheduleSetsTrigger|TenuVaultAutomationAccountId|acdd72a7-3385-48ef-bd42-f606fba81ae7|RoleName "Reader"|automationAccountId/)
    // The test run it prints is started by hand; the hint depends on the published runbook (tested below).
    expect(setup).toContain("Write-TenuVaultTestRunHint -Runbook $runbook")
    expect(setup).toContain('$plainRunbookVersion = "1.2.0"')
    expect(setup).toContain('$triggerRunbookVersion = "1.4.0"')
  })

  it("creates no Key Vault, asks for no recovery key and refuses to guess about alerting", () => {
    for (const keyVault of ["Read-Host", "-AsSecureString", "Az.KeyVault", "New-AzKeyVault", "Set-AzKeyVaultSecret", "Get-AzKeyVaultSecret", "Key Vault Secrets", "tenuvault-recovery-key", "$KeyVaultName", "keyVault="]) {
      expect(setup, keyVault).not.toContain(keyVault)
    }
    expect(setup).not.toMatch(/\[string\]\$RecoveryKey/)
    expect(setup).not.toContain('Set-TenuVaultAutomationVariable -Name "TenuVaultKeyVault')
    expect(setup).toContain("-NoFailureAlert")
    expect(setup).toContain("Decide how failed cloud backups will be noticed")
  })

  it("upgrades an older setup in place and names its Key Vault for deletion", () => {
    expect(setup).toContain('$legacyKeyVaultVariable = "TenuVaultKeyVault-$tenantKey"')
    // A rerun drops the variable the runbook no longer reads, after the current variables are written.
    const removal = setup.indexOf("Remove-TenuVaultLegacyKeyVaultVariable -Runbook $runbook")
    expect(removal).toBeGreaterThan(setup.indexOf('-Name "TenuVaultAppOnlyExcluded-$tenantKey"'))
    expect(removal).toBeGreaterThan(setup.indexOf("$runbook = Publish-TenuVaultRunbook"))
    expect(setup).toContain("Publish-AzAutomationRunbook")
    // -Remove deletes it too and, like a rerun, names the old vault before it is gone.
    expect(setup).toContain("foreach ($name in @($variableNames) + $legacyKeyVaultVariable)")
    expect(setup).toContain("if ($Remove) {\n    Remove-TenuVaultCloudBackupSetup\n    return\n}")
    const removeMode = setup.slice(setup.indexOf("function Remove-TenuVaultCloudBackupSetup"), setup.indexOf("function Assert-TenuVaultAuthorizationActions"))
    expect(removeMode.indexOf("$legacyKeyVaults = Get-TenuVaultLegacyKeyVaults")).toBeLessThan(removeMode.indexOf("Remove-AzAutomationVariable"))
    expect(removeMode).toContain("Write-TenuVaultLegacyKeyVaultNote $legacyKeyVaults")
    expect(setup).toContain('-ResourceType "Microsoft.KeyVault/vaults"')
    expect(setup).toContain('$_.Name -like "kv-tenuvault-*"')
    expect(setup).toContain("TenuVault setup in this or any other Automation account still has a TenuVaultKeyVault variable")
    expect(setup).toContain("open in TenuVault with it")
    // The variable goes only when the published runbook, read back from Azure, no longer reads it.
    expect(setup).toContain("-Slot Published -OutputFolder $folder")
    expect(setup).toContain('$plainRunbookVersion = "1.2.0"')
    expect(setup).toContain('-Force -Confirm:$false | Out-Null\n    Publish-AzAutomationRunbook')
  })

  type SetupScenario = {
    scenario: string; plain: boolean; reason: string | null; error: string | null; actions: string[]
    legacyVariableKept: boolean; changeReport?: string | null; changeReportActors?: string | null; tenantName?: string | null
    variables: string[]; variableWrites: string[]; scope: string; exclusions: string; appOnlyExcluded: string
    schedule: boolean; enabled: boolean; link: boolean; output: string[]
    scheduleSettings: { timeZone: string; frequency: string; time: string; days: string[] }
  }
  const readSetupScenarios = (setupPath?: string) => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/setup-upgrade.ps1", import.meta.url))
    const args = ["-NoProfile", "-File", script, ...(setupPath ? ["-SetupPath", setupPath] : [])]
    const lines = execFileSync(pwsh!, args, { encoding: "utf8" }).split(/\r?\n/).filter((line) => line.startsWith("{"))
    return new Map(lines.map((line) => JSON.parse(line) as SetupScenario).map((run) => [run.scenario, run]))
  }
  let setupScenarios: Map<string, SetupScenario> | undefined
  const setupRun = (name: string) => (setupScenarios ??= readSetupScenarios()).get(name)!
  let mainSetupScenarios: Map<string, SetupScenario> | undefined
  const mainSetup = () => {
    const main = process.env.TENUVAULT_TEST_MAIN_WORKTREE
    if (main) return mainSetupScenarios ??= readSetupScenarios(join(main, "resources/New-TenuVaultCloudBackup.ps1"))
  }
  const DELETE_ADVICE = "Delete the vault once no"

  it.runIf(Boolean(pwsh))("keeps the change report level and actors on a rerun without their parameters, and sets them when passed", () => {
    // An upgrade with a command that does not carry the change report choice keeps it.
    expect(setupRun("rerun-keeps-report")).toMatchObject({ error: null, changeReport: "names", changeReportActors: "false", tenantName: "Contoso" })
    // An empty -TenantName clears the saved name to the tenant id, never to an empty value.
    expect(setupRun("rerun-sets-report")).toMatchObject({ error: null, changeReport: "full", changeReportActors: "true", tenantName: "11111111-2222-3333-4444-555555555555" })
    expect(setup).toContain('$changeReportPassed = $PSBoundParameters.ContainsKey("ChangeReport")')
    expect(setup).toContain('$changeReportActorsPassed = $PSBoundParameters.ContainsKey("ChangeReportWithoutActors")')
  }, 130_000)

  it.runIf(Boolean(pwsh))("follows main for disabled schedules, including stale markers and partial overrides", () => {
    expect(setup).not.toContain("TenuVaultAuditPausedSchedule")
    const baseline = mainSetup()
    const scheduleResult = ({ error, schedule, enabled, link, scheduleSettings, actions }: SetupScenario) => ({
      error, schedule, enabled, link, scheduleSettings,
      scheduleWrites: actions.filter((action) => /schedule|^(un)?link$/.test(action)),
    })
    for (const scenario of ["disabled-stale-marker", "disabled-time-override"]) {
      const actual = setupRun(scenario)
      const result = scheduleResult(actual)
      expect(result).toEqual({
        error: null, schedule: true, enabled: false, link: true, scheduleWrites: [],
        scheduleSettings: { timeZone: "Europe/Berlin", frequency: "Week", time: "09:00", days: ["Wednesday"] },
      })
      expect(actual.variables).toContain("TenuVaultAuditPausedSchedule-11111111")
      if (baseline) expect(result).toEqual(scheduleResult(baseline.get(scenario)!))
    }

    // Explicit Graph confirmation still requests the replacement that main performs.
    const scenario = "disabled-explicit-replacement"
    const result = scheduleResult(setupRun(scenario))
    expect(result).toMatchObject({
      error: null, schedule: true, enabled: true, link: true,
      scheduleWrites: ["unlink", "remove schedule", "create schedule", "link"],
      scheduleSettings: { timeZone: "UTC", frequency: "Day", time: "10:00" },
    })
    if (baseline) expect(result).toEqual(scheduleResult(baseline.get(scenario)!))
  }, 60_000)

  it.runIf(Boolean(pwsh))("writes main's scope variables on default and Everything reruns", () => {
    // The omission enrollment variable is new in this release; every variable main writes is unchanged.
    const variableResult = ({ scope, exclusions, appOnlyExcluded, variableWrites }: SetupScenario) => ({
      scope, exclusions, appOnlyExcluded, variableWrites: variableWrites.filter(name => !name.startsWith("TenuVaultOmissionAccount-")),
    })
    const baseline = mainSetup()
    for (const [scenario, scope] of [["linked-upgrade", "policies"], ["linked-upgrade-everything", "everything"]] as const) {
      const result = variableResult(setupRun(scenario))
      expect(result).toEqual({
        scope, exclusions: "", appOnlyExcluded: "DeviceCategories,DeviceCleanupRules",
        variableWrites: ["TenantId", "StorageAccount", "Scope", "ExcludedFolders", "AppOnlyExcluded"].map(name => `TenuVault${name}-11111111`),
      })
      if (baseline) expect(result).toEqual(variableResult(baseline.get(scenario)!))
    }
  }, 60_000)

  it.runIf(Boolean(pwsh))("publishes, creates and links the schedule when audit provisioning is denied", () => {
    for (const failure of ["container", "role-definition", "role-assignment"]) {
      const run = setupRun(`audit-${failure}-denied`)
      expect(run).toMatchObject({ error: null, plain: true, schedule: true, enabled: true, link: true })
      expect(run.output).toContainEqual(expect.stringContaining("Could not provision cloud backup audit access"))
      expect(run.output).toContainEqual(expect.stringContaining("assign it to the Automation account"))
    }
  }, 60_000)

  it.runIf(Boolean(pwsh))("gives both required cloud backup grants priority when Azure RBAC quota is tight", () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/setup-upgrade.ps1", import.meta.url))
    const run = (...args: string[]) => JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, "-RbacQuota", ...args], {
      encoding: "utf8", timeout: auditSetupTimeout,
    })) as { actions: string[]; published: boolean; schedule: boolean; linked: boolean; output: string[] }
    const { actions, output, ...result } = run()
    expect(result).toEqual({ published: true, schedule: true, linked: true })
    expect(actions).toEqual([
      "grant intune-backups", "grant tenuvault-backup-results", "import confirm=False", "publish", "export Published",
      "create schedule", "link", "grant audit-logs",
    ])
    expect(output).toContainEqual(expect.stringContaining("RoleAssignmentLimitExceeded"))
    const main = process.env.TENUVAULT_TEST_MAIN_WORKTREE
    if (main) {
      const { output: _output, ...baseline } = run("-SetupPath", join(main, "resources/New-TenuVaultCloudBackup.ps1"))
      expect({ actions: actions.slice(0, -1), ...result }).toEqual(baseline)
    }
    expect(run("-AuditRoleOnly")).toMatchObject({ actions: ["grant audit-logs"], published: false, schedule: false, linked: false })
  }, 60_000)

  it("documents audit availability by producer version and the Backup Writer's overwrite rights", () => {
    const storage = readFileSync(new URL("../docs-site/src/content/docs/backups/storage.md", import.meta.url), "utf8")
    const schedules = readFileSync(new URL("../docs-site/src/content/docs/backups/schedules.mdx", import.meta.url), "utf8")
    expect(storage).toContain("Cloud runbook 1.5.0 and later record terminal events")
    expect(storage).toContain("Backup Writer** role can overwrite existing blobs")
    expect(storage).not.toContain("runs write nothing")
    expect(schedules).toContain("current Backup Reader and cloud runbook 1.5.0 and later")
  })

  it.runIf(Boolean(pwsh))("recommends TRIGGER Manual for the test run only when the published runbook has it", () => {
    const manual = "TRIGGER to Manual, and watch the job output. The backup then appears in TenuVault under"
    // Published and read back as this runbook (1.4.0 or later): start it with TRIGGER set to Manual.
    const approved = setupRun("approved").output
    expect(approved).toContain(manual)
    expect(approved).toContain("Automation account, Runbooks > Invoke-TenuVaultBackup > Start, set TENANTKEY to 11111111 and")
    // The publish left 1.1.0 published, was declined, or threw before a read back: no TRIGGER in its Start pane.
    const older = setupRun("published-older").output
    expect(older).not.toContain(manual)
    expect(older).toContain("Scheduled: the published runbook is version 1.1.0, older than 1.4.0, so it has no TRIGGER to record a run started by hand.")
    expect(older).toContain("Run this script again and let it publish the runbook; then a run started with TRIGGER set")
    const declined = setupRun("outer-declined").output
    expect(declined).not.toContain(manual)
    expect(declined).toContain("Scheduled: the published runbook could not be read back as 1.4.0 or later, so it has no TRIGGER to record a run started by hand.")
  }, 60_000)

  it.runIf(Boolean(pwsh))("removes the Key Vault variable only when the published runbook reads back as plain", () => {
    const approved = setupRun("approved")
    expect(approved).toMatchObject({ plain: true, legacyVariableKept: false, error: null })
    // The import is told not to prompt again after the one approval, and the result is read back from the Published slot.
    expect(approved.actions).toEqual(["import confirm=False", "publish", "export Published", "remove TenuVaultKeyVault-11111111"])
    expect(approved.output.join(" ")).toContain(DELETE_ADVICE)
    for (const [name, reason] of [
      ["outer-declined", "the runbook import and publish was not approved"],
      // The import's own prompt declined with an older draft present: that draft is what got published.
      ["import-declined", "the published runbook is still version 1.1.0, older than 1.2.0"],
      ["published-older", "the published runbook is still version 1.1.0, older than 1.2.0"],
    ] as const) {
      const run = setupRun(name)
      expect(run, name).toMatchObject({ plain: false, reason, legacyVariableKept: true })
      expect(run.output, name).toContain(`Kept 'TenuVaultKeyVault-11111111': ${reason}. Run this script again to finish the upgrade.`)
      expect(run.output.join(" "), name).toContain(`Keep Key Vault kv-tenuvault-abc123: ${reason}`)
      expect(run.output.join(" "), name).not.toContain(DELETE_ADVICE)
    }
    expect(setupRun("outer-declined").actions).toEqual([])
    // A publish that throws stops the run before any variable changes.
    expect(setupRun("publish-throws")).toMatchObject({ error: "Publishing the runbook failed.", legacyVariableKept: true })
    expect(setupRun("publish-throws").actions).toEqual(["import confirm=False", "publish"])
  }, 60_000)

  it.runIf(Boolean(pwsh))("advises deleting the vault after -Remove only when the tenant's setup is gone", () => {
    const complete = setupRun("remove-complete")
    expect(complete).toMatchObject({ schedule: false, link: false, legacyVariableKept: false, variables: [] })
    expect(complete.output).toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
    expect(complete.output.join(" ")).toContain(DELETE_ADVICE)
    for (const name of ["remove-whatif", "remove-variable-declined"]) {
      const run = setupRun(name)
      expect(run.output.join(" "), name).toContain("were not fully removed. Still in place:")
      expect(run.output.join(" "), name).toContain("Keep Key Vault kv-tenuvault-abc123: this tenant's cloud backup setup was not fully removed")
      expect(run.output.join(" "), name).not.toContain(DELETE_ADVICE)
      expect(run.output, name).not.toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
    }
    // -WhatIf changes nothing; a declined variable is named as left in place.
    expect(setupRun("remove-whatif")).toMatchObject({ actions: [], schedule: true, link: true, legacyVariableKept: true })
    expect(setupRun("remove-variable-declined").output.join(" ")).toContain("Still in place: variable 'TenuVaultScope-11111111'.")
  }, 60_000)

  it.runIf(Boolean(pwsh))("treats a failed -Remove lookup as unverified, not as removed", () => {
    // -WhatIf removes nothing, and every lookup fails with a transport error instead of "not found".
    const run = setupRun("remove-whatif-lookups-fail")
    expect(run).toMatchObject({ schedule: true, link: true, legacyVariableKept: true })
    const text = run.output.join(" ")
    expect(text).toContain("The removal could not be verified. Could not check: the link of 'Invoke-TenuVaultBackup' to 'TenuVaultBackup-11111111' (The SSL connection could not be established.); schedule 'TenuVaultBackup-11111111'")
    expect(text).toContain("variable 'TenuVaultKeyVault-11111111' (The SSL connection could not be established.)")
    expect(text).toContain("Keep Key Vault kv-tenuvault-abc123: the removal of this tenant's cloud backup setup could not be verified")
    expect(text).not.toContain("removed.")
    expect(text).not.toContain(DELETE_ADVICE)
    // A real "not found" still counts as gone.
    expect(setupRun("remove-complete").output.join(" ")).not.toContain("could not be verified")
  }, 60_000)

  it.runIf(Boolean(pwsh))("decides variable absence from one complete list, not from a by-name read the client reports as not found", () => {
    // Az.Automation turns a 403 or 500 on one variable into ResourceNotFoundException. The list still shows the variable.
    const declined = setupRun("remove-scope-read-403-declined")
    expect(declined.variables).toEqual(["TenuVaultScope-11111111"])
    expect(declined.output.join(" ")).toContain("were not fully removed. Still in place: variable 'TenuVaultScope-11111111'.")
    expect(declined.output.join(" ")).toContain("Keep Key Vault kv-tenuvault-abc123: this tenant's cloud backup setup was not fully removed")
    expect(declined.output.join(" ")).not.toContain(DELETE_ADVICE)
    expect(declined.output).not.toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
    // The same misreport during removal does not skip the variable: the list says it exists, so it is removed and verified gone.
    const served = setupRun("remove-scope-read-500")
    expect(served.actions).toContain("remove TenuVaultScope-11111111")
    expect(served.variables).toEqual([])
    expect(served.output).toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
    // The upgrade finds the vault variable through the list too, so it is removed rather than left behind unnoticed.
    const upgrade = setupRun("upgrade-vault-read-translated")
    expect(upgrade).toMatchObject({ plain: true, legacyVariableKept: false })
    expect(upgrade.actions).toContain("remove TenuVaultKeyVault-11111111")
    // A failing list leaves every variable unknown: never removed, never advice.
    const listFails = setupRun("remove-list-fails")
    const text = listFails.output.join(" ")
    expect(text).toContain("The removal could not be verified. Could not check: variable 'TenuVaultTenantId-11111111' (The SSL connection could not be established.)")
    expect(text).toContain("variable 'TenuVaultKeyVault-11111111' (The SSL connection could not be established.)")
    expect(text).toContain("Keep Key Vault kv-tenuvault-abc123: the removal of this tenant's cloud backup setup could not be verified")
    expect(text).not.toContain(DELETE_ADVICE)
    expect(listFails.output).not.toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
  }, 60_000)

  it.runIf(Boolean(pwsh))("keeps the vault while another tenant in the Automation account still has its variable, or when that cannot be checked", () => {
    for (const name of ["upgrade-tenant-b-remains", "remove-tenant-b-remains"]) {
      const run = setupRun(name)
      const text = run.output.join(" ")
      expect(run.variables, name).toContain("TenuVaultKeyVault-22222222")
      expect(run.variables, name).not.toContain("TenuVaultKeyVault-11111111")
      expect(text, name).toContain("Keep Key Vault kv-tenuvault-abc123: tenant key(s) 22222222 in Automation account 'aa-tenuvault' still have a TenuVaultKeyVault variable; run this script for those tenants too")
      expect(text, name).not.toContain(DELETE_ADVICE)
    }
    expect(setupRun("upgrade-tenant-b-remains").plain).toBe(true)
    // A failing variable list: the upgrade keeps the vault variable, and the vault, because nothing can be called absent.
    const upgradeListFails = setupRun("upgrade-list-fails")
    expect(upgradeListFails.legacyVariableKept).toBe(true)
    expect(upgradeListFails.output.join(" ")).toContain("Kept 'TenuVaultKeyVault-11111111' if it exists: the Automation account's variables could not be listed (The SSL connection could not be established.)")
    expect(upgradeListFails.output.join(" ")).toContain("Keep Key Vault kv-tenuvault-abc123: the variables of Automation account 'aa-tenuvault' could not be read to check which setups still use it")
    expect(upgradeListFails.output.join(" ")).not.toContain(DELETE_ADVICE)
    // With no TenuVaultKeyVault variable left, the advice stays neutral: it never claims the vault is unused elsewhere.
    const advice = setupRun("approved").output.join(" ")
    expect(advice).toContain("no tenant in Automation account 'aa-tenuvault' still has a TenuVaultKeyVault variable")
    expect(advice).toContain("Delete the vault once no TenuVault setup in this or any other Automation account still has a TenuVaultKeyVault variable")
    expect(advice).not.toContain("is no longer read")
  }, 60_000)

  it("scopes the writer role to the container without delete and prints the paste block", () => {
    expect(setup).toContain('"TenuVault Backup Writer"')
    // Az.Resources 10 exposes Permissions instead of flattened role Actions/DataActions.
    expect(setup).toContain("PSObject.Properties.Name -contains 'Permissions'")
    expect(setup).toContain("$definition.Permissions.Add($permission)")
    expect(setup).toContain("foreach ($permission in $role.Permissions)")
    expect(setup).not.toMatch(/\$extra = @\(\$role\.DataActions/)
    expect(setup).toContain("New-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionId $RoleDefinitionId")
    expect(setup).toContain("-RoleDefinitionId ([string]$role.Id)")
    // Storage may live outside the Automation resource group; check role access there before writes.
    expect(setup).toContain("$storageGroupScope = ($storageAccount.Id -split '/providers/')[0]")
    expect(setup).toContain("Assert-TenuVaultAuthorizationActions -Scope $storageGroupScope")
    expect(setup.indexOf("Assert-TenuVaultAuthorizationActions -Scope $storageGroupScope")).toBeLessThan(setup.indexOf("New-AzResourceGroup"))
    expect(setup).toContain("Microsoft.Authorization/roleAssignments/write")
    expect(setup).toContain("Microsoft.Authorization/roleDefinitions/write")
    expect(setup).not.toContain("blobs/delete")
    expect(setup).toContain("containers/$backupContainer")
    // The runbook parses with System.Text.Json, which the default 5.1 runtime lacks.
    expect(setup).toContain("-Type PowerShell72")
    expect(setup).toContain("--- TenuVault cloud backup setup (paste into TenuVault) ---")
    expect(setup).toContain("tenantKey=$tenantKey")
  })
})

describe("azuredeploy.json", () => {
  it("creates the same pieces and hands the paste block back, without pretending to grant Graph roles", () => {
    const types = template.resources.map((resource) => resource.type)
    for (const type of [
      "Microsoft.Automation/automationAccounts",
      "Microsoft.Automation/automationAccounts/runbooks",
      "Microsoft.Automation/automationAccounts/schedules",
      "Microsoft.Automation/automationAccounts/jobSchedules",
      "Microsoft.Authorization/roleDefinitions",
    ]) expect(types, type).toContain(type)
    const runbookResource = template.resources.find((resource) => resource.type === "Microsoft.Automation/automationAccounts/runbooks") as unknown as { properties: { runbookType: string } }
    expect(runbookResource.properties.runbookType).toBe("PowerShell72")
    expect(Object.keys(template.outputs)).toContain("pasteIntoTenuVault")
    const paste = (template.outputs.pasteIntoTenuVault as { value: string }).value
    expect(paste).toContain("time=")
    expect(paste).toContain("substring(parameters('scheduleStartTime'), 11, 5)")
    expect(Object.keys(template.outputs)).toContain("graphRolesToAssign")
  })

  it("creates no Key Vault, secret or vault role and takes no recovery key", () => {
    expect(template.resources.filter((resource) => resource.type.startsWith("Microsoft.KeyVault/"))).toEqual([])
    expect(Object.keys(template.parameters)).not.toContain("recoveryKey")
    expect(Object.keys(template.parameters)).not.toContain("keyVaultName")
    expect(Object.values(template.parameters).map((parameter) => (parameter as { type: string }).type)).not.toContain("securestring")
    // The description may name the old vault for upgrades; nothing the template deploys or outputs does.
    const text = JSON.stringify({ ...template, metadata: undefined })
    for (const keyVault of ["keyVault", "TenuVaultKeyVault", "tenuvault-recovery-key", "keyVaultSecretsUserRoleId", "4633458b-17de-408a-b874-0445c86b69e6"]) {
      expect(text, keyVault).not.toContain(keyVault)
    }
    // The vault assignment is gone; two backup writer assignments and one audit writer assignment remain.
    expect(template.resources.filter((resource) => resource.type === "Microsoft.Authorization/roleAssignments")).toHaveLength(3)
  })

  it("links with TENANTKEY only and uses an existing identity for optional migration", () => {
    const resources = template.resources as unknown as Array<{ type: string; scope?: string; properties: Record<string, unknown> }>
    const jobSchedule = resources.find((resource) => resource.type === "Microsoft.Automation/automationAccounts/jobSchedules")!
    expect(jobSchedule.properties.parameters).toEqual({ TenantKey: "[variables('tenantKey')]" })
    const accountGrants = resources.filter((resource) => resource.type === "Microsoft.Authorization/roleAssignments" && resource.scope?.includes("Microsoft.Automation/automationAccounts/"))
    expect(accountGrants).toHaveLength(0)
    expect(resources.find(resource => resource.type === "Microsoft.Resources/deploymentScripts")).toMatchObject({
      identity: { type: "UserAssigned", userAssignedIdentities: "[createObject(parameters('omissionMigrationIdentityId'), createObject())]" },
    })
    const text = JSON.stringify(template)
    for (const absent of ["TenuVaultAutomationAccountId", "TenuVaultScheduleSetsTrigger", "Trigger"]) expect(text, absent).not.toContain(absent)
  })

  it("lets the identity leave result notes in the watcher's container with the same write-only role", () => {
    const resources = template.resources as unknown as Array<{ type: string; name: string; scope?: string; properties: Record<string, unknown> }>
    const container = resources.find((resource) => resource.type === "Microsoft.Storage/storageAccounts/blobServices/containers")!
    expect(container.name).toContain("variables('outcomeContainer')")
    expect(container.properties.publicAccess).toBe("None")
    expect((template as unknown as { variables: Record<string, string> }).variables.outcomeContainer).toBe("tenuvault-backup-results")
    const assignments = resources.filter((resource) => resource.type === "Microsoft.Authorization/roleAssignments" && resource.scope?.includes("variables('outcomeContainer')"))
    expect(assignments).toHaveLength(1)
    // The writer role it uses never allows delete.
    expect(String(assignments[0]!.properties.roleDefinitionId)).toContain("variables('writerRoleName')")
    const role = resources.find((resource) => resource.type === "Microsoft.Authorization/roleDefinitions")!
    expect(JSON.stringify((role.properties as { permissions: unknown }).permissions)).not.toContain("delete")
  })
})


it.runIf(Boolean(pwsh))("cloud runs fail closed on unverified policies and preserve the off-mode OMA snapshot format", () => {
  const runs = runPlainFixture()
  for (const scenario of ["forbidden", "ambiguous404", "unavailable", "malformed", "arrayTenant"]) {
    const run = runs.find(entry => entry.scenario === scenario)!
    expect(run.error).toContain("omission policy could not be verified")
    expect(run.calls.some(({ uri }) => uri.startsWith("https://graph.microsoft.com") || uri.includes("/intune-backups/backup-"))).toBe(false)
  }
  const off = runs.find(entry => entry.scenario === "containerMissing")!
  expect(off.error).toBeNull()
  expect(off.calls.filter(({ uri }) => uri.includes("getOmaSettingPlainTextValue"))).toHaveLength(1)
  const blobs = writtenBlobs(off)
  const folder = folderOf(blobs)
  const snapshot = JSON.parse(blobs.get(`${folder}/DeviceConfigurations/Baseline Wi-Fi.json` )!)
  expect(snapshot.omaSettings).toEqual([
    { isEncrypted: true, value: "Graph value" },
    { isEncrypted: true, secretReferenceValueId: "ref", value: "****" },
  ])
  const item = JSON.parse(blobs.get(`${folder}/metadata.json`)!).Items["DeviceConfigurations/cfg-1"]
  // **** stays blocked on restore as on main, so it is not recorded as hydration evidence.
  expect(item).not.toHaveProperty("hydratedOmaMasks")
  expect(item).not.toHaveProperty("secretsMasked")
  expect(item).not.toHaveProperty("partialCollections")
}, 60_000)

it.runIf(Boolean(pwsh))("requires verified Automation enrollment before treating an absent policy as off", () => {
  const runs = runPlainFixture()
  const unavailable = runs.find(entry => entry.scenario === "unreadableEnrollment")!
  expect(unavailable.error).toContain("Automation enrollment variable could not be read")
  expect(unavailable.calls.some(({ uri }) => uri.includes("secret-omission.json"))).toBe(true)
  expect(unavailable.calls.some(({ uri }) => uri.includes("graph.microsoft.com") || uri.includes("/intune-backups/backup-"))).toBe(false)
  const absent = runs.find(entry => entry.scenario === "missingEnrollment")!
  expect(absent.error).toBeNull()
  const blobs = writtenBlobs(absent)
  expect(JSON.parse(blobs.get(`${folderOf(blobs)}/metadata.json`)!)).toMatchObject({ OmissionEnabled: false })
}, 60_000)

it.runIf(Boolean(pwsh))("writes a default-off manifest without Automation cmdlets unless the environment records enrollment", () => {
  const runs = runPlainFixture()
  for (const scenario of ["environmentUnset", "environmentEmpty"]) {
    const run = runs.find(entry => entry.scenario === scenario)!
    expect(run.error).toBeNull()
    const blobs = writtenBlobs(run)
    expect(JSON.parse(blobs.get(`${folderOf(blobs)}/metadata.json`)!)).toMatchObject({ Status: "Success", OmissionEnabled: false })
  }
  const enrolled = runs.find(entry => entry.scenario === "environmentEnrolled")!
  expect(enrolled.error).toContain("omission policy could not be verified")
  expect(enrolled.calls.some(({ uri }) => uri.includes("/intune-backups/backup-"))).toBe(false)
}, 60_000)

it.runIf(Boolean(pwsh))("stops capture after an enrolled storage move until the destination has an explicit policy", () => {
  const runs = runPlainFixture()
  const missing = runs.find(entry => entry.scenario === "movedWithoutPolicy")!
  expect(missing.error).toContain("Enable omission on the new account or explicitly set it off")
  expect(missing.calls.some(({ uri }) => uri.includes("graph.microsoft.com") || uri.includes("/intune-backups/backup-"))).toBe(false)
  for (const [scenario, enabled] of [["movedWithOffPolicy", false], ["movedWithOnPolicy", true]] as const) {
    const run = runs.find(entry => entry.scenario === scenario)!
    expect(run.error).toBeNull()
    const blobs = writtenBlobs(run)
    expect(JSON.parse(blobs.get(`${folderOf(blobs)}/metadata.json`)!)).toMatchObject({ OmissionEnabled: enabled })
  }
}, 60_000)

it.runIf(Boolean(pwsh))("hydrates an empty OMA reference off-mode and reports a failed lookup", () => {
  const runs = runPlainFixture()
  const success = runs.find(entry => entry.scenario === "emptyOmaSuccess")!
  const refused = runs.find(entry => entry.scenario === "emptyOmaFailure")!
  for (const run of [success, refused]) {
    expect(run.calls.filter(({ uri }) => uri.endsWith("getOmaSettingPlainTextValue(secretReferenceValueId='')"))).toHaveLength(1)
  }
  const blobs = writtenBlobs(success)
  expect(JSON.parse(blobs.get(`${folderOf(blobs)}/DeviceConfigurations/Baseline Wi-Fi.json`)!)).toMatchObject({
    omaSettings: [{ value: "Hydrated empty reference", secretReferenceValueId: "" }],
  })
  const failedBlobs = writtenBlobs(refused)
  const failedFolder = folderOf(failedBlobs)
  expect(failedBlobs.has(`${failedFolder}/DeviceConfigurations/Baseline Wi-Fi.json`)).toBe(false)
  expect(JSON.parse(failedBlobs.get(`${failedFolder}/metadata.json`)!)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1 })
}, 60_000)

it.runIf(Boolean(pwsh))("keeps off-mode cloud report fields and compares matched typed and untyped tokens only under omission", () => {
  const script = fileURLToPath(new URL("./fixtures/cloud-backup/omission-compare.ps1", import.meta.url))
  const { off, on, offWithOneSkip } = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 60_000 }))
  expect(off.ExcludedPaths).toEqual([])
  expect(off.Warnings).toEqual([])
  expect(off.Drifts).toHaveLength(1)
  expect(JSON.stringify(off.Drifts[0].changes)).toContain("nested.children")
  expect(offWithOneSkip.Drifts).toEqual([])
  expect(on.ExcludedPaths).toEqual(["/nested/children"])
  expect(on.Drifts).toEqual([])
}, 60_000)
