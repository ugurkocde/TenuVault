import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { AuditStorageService } from "../src/portal/lib/audit/storage"
import { auditExportJSON } from "../src/portal/lib/audit/export"
import { createHash } from "node:crypto"
import { INTUNE_TYPES, typeForFolder } from "../src/shared/intune/registry"
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
type RunCall = { condition?: string; uri: string; method: string; contentType: string | null; ifNoneMatch: string | null; body: string | null }
type Run = { calls: RunCall[]; error?: string | null; output?: string[] }
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
  resources: Array<{ type: string }>
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
        job: { status, producer: "cloud-runbook", producerVersion: "1.5.0", stage: "terminal" } })
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
    expect(new Set(lists.map(call => new URL(call.uri).searchParams.get("prefix"))).size).toBe(14)
    expect(lists.some(call => new URL(call.uri).searchParams.get("marker"))).toBe(true)
    expect((result.calls as RunCall[]).some(call => call.uri.includes("/audit-cursors/"))).toBe(true)
    expect((result.calls as RunCall[]).some(call => call.uri.includes("55555555-5555-5555-5555-555555555555.json"))).toBe(false)
  }, 60_000)

  type RestartRun = Run & { blobs: Record<string, string> }
  type RestartScenarios = Record<string, RestartRun> & {
    identity: { token: string; calls: number }
    transport: { budgeted: number; unbudgeted: number; remaining: number }
  }
  let restartRuns: RestartScenarios | undefined
  const runRestartFixture = () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-restart.ps1", import.meta.url))
    return restartRuns ??= JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 50_000 })) as RestartScenarios
  }
  const restartRun = (name: string) => runRestartFixture()[name]!
  const auditFiles = (run: RestartRun) => Object.entries(run.blobs).filter(([uri]) => uri.includes("/audit-logs/"))
  const manifestFiles = (run: RestartRun) => Object.entries(run.blobs).filter(([uri]) => uri.endsWith("/metadata.json"))
  const outcomeFiles = (run: RestartRun) => Object.entries(run.blobs).filter(([uri]) => uri.includes("/cloud-backup-outcomes/"))

  it.runIf(Boolean(pwsh))("recovers when the managed identity endpoint succeeds on the third attempt", () => {
    expect(runRestartFixture().identity).toEqual({ token: "token", calls: 3 })
  }, 60_000)

  it.runIf(Boolean(pwsh))("charges each transport attempt to the replay budget", () => {
    expect(runRestartFixture().transport).toEqual({ budgeted: 1, unbudgeted: 3, remaining: 0 })
  }, 60_000)

  it.runIf(Boolean(pwsh)).each(["startReadDenied", "startWriteDenied"])("captures even when the audit start checkpoint is unavailable (%s)", name => {
    const run = restartRun(name)
    expect(run.error).toBeNull()
    expect(run.output!.join("\n")).toContain("could not verify or save its start checkpoint")
    expect(run.calls.some(call => call.uri.includes("graph.microsoft.com"))).toBe(true)
    expect(JSON.parse(manifestFiles(run)[0]![1]).Status).toBe("Success")
    expect(JSON.parse(outcomeFiles(run)[0]![1]).status).toBe("Success")
    expect(JSON.parse(auditFiles(run)[0]![1]).entries[0].job.status).toBe("completed")
  }, 60_000)

  it.runIf(Boolean(pwsh))("verifies the interrupted run's manifest when its terminal checkpoint cannot be read", () => {
    const run = restartRun("terminalReadDenied")
    expect(run.error).toBeNull()
    expect(run.output!.join("\n")).toContain("could not verify its terminal checkpoint")
    expect(run.calls.some(call => call.uri.includes("graph.microsoft.com"))).toBe(false)
    expect(run.calls.some(call => call.method === "Get" && call.uri.endsWith("/metadata.json"))).toBe(true)
    expect(manifestFiles(run)).toEqual(manifestFiles(restartRun("crash")))
    expect(auditFiles(run)).toEqual(auditFiles(restartRun("crashRestart")))
  }, 60_000)

  it.runIf(Boolean(pwsh))("recovers a committed Automation job before capture and replays its original terminal event", () => {
    const interrupted = restartRun("crash")
    const restarted = restartRun("crashRestart")
    expect(auditFiles(interrupted)).toHaveLength(0)
    const [[, rawManifest]] = manifestFiles(interrupted) as [[string, string]]
    const manifest = JSON.parse(rawManifest)
    const start = interrupted.calls.findIndex(call => call.method === "Put" && call.uri.includes("/audit-runs/") && call.uri.endsWith("/start.json"))
    const graph = interrupted.calls.findIndex(call => call.uri.includes("graph.microsoft.com"))
    expect(start).toBeGreaterThan(-1)
    expect(start).toBeLessThan(graph)
    const checkpoint = JSON.parse(interrupted.blobs[interrupted.calls[start]!.uri]!)
    expect(checkpoint).toMatchObject({ jobId: manifest.RunId, runId: manifest.RunId, folder: manifest.BackupFolder })
    expect(restarted.error).toBeNull()
    expect(restarted.calls.some(call => call.uri.includes("graph.microsoft.com"))).toBe(false)
    expect(manifestFiles(restarted)).toEqual(manifestFiles(interrupted))
    expect(auditFiles(restarted)).toHaveLength(1)
    expect(JSON.parse(auditFiles(restarted)[0]![1]).entries[0].job).toMatchObject({ runId: manifest.RunId, status: "completed" })

    const original = restartRun("lostAck")
    const replay = restartRun("lostAckRestart")
    expect(replay.calls.some(call => call.uri.includes("graph.microsoft.com"))).toBe(false)
    expect(auditFiles(replay)).toEqual(auditFiles(original))
    expect(replay.calls.filter(call => call.method === "Put" && call.uri.includes("/audit-logs/"))).toHaveLength(0)
  }, 60_000)

  it.runIf(Boolean(pwsh))("uses the verified manifest after Azure commits a PUT whose acknowledgement was lost", () => {
    const run = restartRun("lostAck")
    expect(run.error).toBeNull()
    const uri = manifestFiles(run)[0]![0]
    expect(run.calls.filter(call => call.uri === uri).map(call => call.method)).toEqual(["Put", "Get"])
    expect(JSON.parse(auditFiles(run)[0]![1]).entries[0].job.status).toBe("completed")
    const note = Object.entries(run.blobs).find(([url]) => url.includes("/cloud-backup-outcomes/"))!
    expect(JSON.parse(note[1]).status).toBe("Success")
  }, 60_000)

  it.runIf(Boolean(pwsh))("requires fresh cloud audit creation on each canary and detects excessive rights", () => {
    const scoped = restartRun("scoped")
    const excessive = restartRun("excessive")
    expect(scoped.error).toBeNull()
    expect(scoped.output).toContain("Cloud backup canary passed. Audit canary created and read. Azure denied audit overwrite and audit and backup deletion.")
    const again = restartRun("scopedAgain")
    expect(again.error).toBeNull()
    expect(again.output).toContain("Cloud backup canary passed. Audit canary created and read. Azure denied audit overwrite and audit and backup deletion.")
    expect(auditFiles(again)).toHaveLength(2)
    expect(Object.keys(scoped.blobs)).toHaveLength(2)
    const revoked = restartRun("revokedCreate")
    expect(revoked.error).toBe("Audit create revoked")
    expect(revoked.calls).toMatchObject([{ method: "Put", uri: expect.stringContaining("/audit-logs/") }])
    expect(revoked.calls[0]!.uri).not.toBe(auditFiles(scoped)[0]![0])
    const lostAck = restartRun("canaryLostAck")
    expect(lostAck.error).toBeNull()
    expect(lostAck.calls.slice(0, 2)).toMatchObject([{ method: "Put" }, { method: "Get", uri: lostAck.calls[0]!.uri }])
    expect(excessive.error).toContain("permission limits failed")
    expect(excessive.output!.join("\n")).toContain("excessive Azure Storage permissions")
    for (const run of [scoped, excessive]) {
      expect(run.calls.every(call => call.uri.includes("/producer-tests/"))).toBe(true)
      expect(run.calls.filter(call => call.method === "Delete").map(call => new URL(call.uri).pathname.split("/")[1])).toEqual(["audit-logs", "intune-backups"])
      expect(run.calls.filter(call => call.method === "Put" && call.condition === "*")).toHaveLength(1)
    }
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
    expect(new Set(lists.map(call => new URL(call.uri).searchParams.get("prefix"))).size).toBe(14)
  }, 60_000)

  it.runIf(Boolean(pwsh))("retains known undelivered counts outside the automatic UTC window until operator replay", () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-replay.ps1", import.meta.url))
    const result = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, "-Aged"], { encoding: "utf8" }))
    expect(result.replay).toMatchObject({ Count: 1, Older: 0 })
    expect(result.replayAgain).toMatchObject({ Count: 1, Older: 1, OlderUnchecked: true })
    expect(result.operator).toMatchObject({ Count: 0, Older: 0, OlderUnchecked: false })
  }, 60_000)

  it.runIf(Boolean(pwsh))("reconciles missing Schedule status and watcher outcome from the terminal checkpoint", () => {
    const first = restartRun("terminalGap")
    const restarted = restartRun("terminalGapRestart")
    expect(Object.keys(first.blobs).some(uri => uri.endsWith("/terminal.json"))).toBe(true)
    expect(Object.keys(first.blobs).some(uri => uri.includes("cloud-backup-status") || uri.includes("cloud-backup-outcomes"))).toBe(false)
    expect(restarted.error).toBeNull()
    expect(restarted.calls.some(call => call.uri.includes("graph.microsoft.com"))).toBe(false)
    const [[, rawManifest]] = manifestFiles(first) as [[string, string]]
    const manifest = JSON.parse(rawManifest)
    const status = JSON.parse(Object.entries(restarted.blobs).find(([uri]) => uri.includes("cloud-backup-status"))![1])
    const note = JSON.parse(Object.entries(restarted.blobs).find(([uri]) => uri.includes("cloud-backup-outcomes"))![1])
    expect(status).toMatchObject({ RunId: manifest.RunId, LastRunAt: manifest.CompletedAt, LastStatus: "Success" })
    expect(note).toMatchObject({ runId: manifest.RunId, finishedAt: manifest.CompletedAt, status: "Success" })
    expect(auditFiles(restarted)).toEqual(auditFiles(first))
  }, 60_000)

  it.runIf(Boolean(pwsh))("writes an unconfirmed cloud commit as a warning under the compatible failed event type", () => {
    const run = restartRun("uncertain")
    expect(run.error).toContain("could not be verified")
    expect(JSON.parse(auditFiles(run)[0]![1]).entries[0]).toMatchObject({
      eventType: "BACKUP_FAILED", severity: "WARNING", job: { status: "uncertain" },
    })
    expect(outcomeFiles(run)).toHaveLength(1)
    expect(JSON.parse(outcomeFiles(run)[0]![1])).toMatchObject({ status: "Failed" })
  }, 60_000)

  it.runIf(Boolean(pwsh))("runs the configured change report before surfacing an audit receipt error", () => {
    const run = runPlainFixture()[8]!
    expect(run.error).toContain("audit receipt could not be persisted")
    const body = (fragment: string) => JSON.parse(run.calls.find(call => call.method === "Put" && call.uri.includes(fragment))!.body!)
    expect(body("/metadata.json").Status).toBe("Success")
    expect(body("/cloud-backup-outcomes/").status).toBe("Success")
    expect(run.calls.some(call => call.uri.includes("/intune-backups?") && call.uri.includes("comp=list"))).toBe(true)
    expect(run.output!.join("\n")).toContain("No earlier complete plain backup")
  }, 60_000)

  it.runIf(Boolean(pwsh))("reports masked OMA values as warnings in every terminal surface", () => {
    const run = runPlainFixture()[7]!
    expect(run.error).toBeNull()
    expect(run.calls.some(call => call.uri.includes("getOmaSettingPlainTextValue"))).toBe(true)
    const body = (fragment: string) => JSON.parse(run.calls.find(call => call.method === "Put" && call.uri.includes(fragment))!.body!)
    expect(body("/metadata.json")).toMatchObject({ Status: "CompletedWithWarnings", MaskedSecretItems: expect.any(Array), Failures: 0 })
    expect(body("/cloud-backup-status-")).toMatchObject({ LastStatus: "CompletedWithWarnings" })
    expect(body("/cloud-backup-outcomes/")).toMatchObject({ status: "CompletedWithWarnings" })
    expect(body("/audit-logs/").entries[0].job).toMatchObject({ status: "warnings", reason: "BACKUP_WARNINGS" })
  }, 60_000)

  it.runIf(Boolean(pwsh))("reports a Graph policy listing 401 at the correct stage", () => {
    const run = restartRun("graph401")
    expect(run.error).toBe("Microsoft Graph policy listing did not finish.")
    expect(JSON.parse(auditFiles(run)[0]![1]).entries[0].job).toMatchObject({ status: "failed", reason: "GRAPH_LIST_FAILED" })
    expect(run.calls.some(call => call.uri.includes(".tenuvault-owner.json"))).toBe(false)
  }, 60_000)

  it("offers an ARM upgrade that leaves a PowerShell setup's backup writer, variables and schedule in place", () => {
    const resources = template.resources as Array<{ type: string; name: string; condition?: string }>
    const audit = resources.filter(resource => resource.name.includes("audit"))
    expect(audit).toHaveLength(3)
    expect(audit.every(resource => !resource.condition)).toBe(true)
    expect(resources.filter(resource => !audit.includes(resource)).every(resource => resource.condition?.includes("not(parameters('auditOnly'))"))).toBe(true)
    expect(template.outputs.pasteIntoTenuVault).toMatchObject({ condition: "[not(parameters('auditOnly'))]" })
    expect(template.parameters.auditOnly).toMatchObject({ type: "bool", defaultValue: false })
  })

  it.runIf(Boolean(pwsh))("creates the same audit role on both setup paths and reuses it on rerun", () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/audit-setup.ps1", import.meta.url))
    const lines = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/)
    const groupScope = "/subscriptions/11111111-1111-1111-1111-111111111111/resourcegroups/rg-audit"
    const bytes = createHash("sha1").update(Buffer.from("11fb06fb712d4ddd98c7e71bbd588830", "hex")).update(groupScope + "-TenuVault Audit Writer").digest()
    bytes[6] = (bytes[6]! & 15) | 80
    bytes[8] = (bytes[8]! & 63) | 128
    const expected = [bytes.subarray(0, 4), bytes.subarray(4, 6), bytes.subarray(6, 8), bytes.subarray(8, 10), bytes.subarray(10, 16)].map(bytes => bytes.toString("hex")).join("-")
    expect(lines).toHaveLength(2)
    for (const line of lines) {
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
  })

  it("describes cloud audit records by runbook version in the history and replay sections", () => {
    const guide = readFileSync(new URL("../docs-site/src/content/docs/backups/cloud.md", import.meta.url), "utf8")
    expect(guide).toMatch(/Audit Log.*starting with runbook 1\.5\.0/)
    expect(guide).not.toMatch(/audit log.*gets no entries/i)
  })

  it("provisions private audit storage with container-scoped read and add only in both setup paths", () => {
    const resources = template.resources as Array<{ type: string; name?: string; scope?: string; properties: Record<string, unknown> }>
    const role = resources.find(resource => resource.type.endsWith("/roleDefinitions") && resource.name?.includes("auditRoleId"))
    expect(role?.properties.permissions).toMatchObject([{ actions: [], dataActions: [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
    ] }])
    expect(resources.find(resource => resource.type.endsWith("/containers") && resource.name?.includes("auditContainer"))?.properties.publicAccess).toBe("None")
    expect(resources.find(resource => resource.type.endsWith("/roleAssignments") && resource.name?.includes("auditRoleName"))?.scope).toContain("variables('auditContainer')")
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
    expect(version).toBe("1.5.0")
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
    // Early failures and the completion helper carry the trigger into the note.
    expect(runbook).toMatch(/Send-TvBackupOutcome -Account [^\n]*-Trigger \$Trigger/)
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
    const puts = run!.calls.filter((call) => call.method === "Put")
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
    expect(removal).toBeGreaterThan(setup.indexOf('Name = "TenuVaultAppOnlyExcluded-$tenantKey"'))
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

  type SetupScenario = { scenario: string; plain: boolean; reason: string | null; error: string | null; actions: string[]; legacyVariableKept: boolean; changeReport?: string | null; changeReportActors?: string | null; tenantName?: string | null; variables: string[]; schedule: boolean; enabled: boolean; link: boolean; output: string[] }
  let setupScenarios: Map<string, SetupScenario> | undefined
  const setupRun = (name: string) => {
    if (!setupScenarios) {
      const script = fileURLToPath(new URL("./fixtures/cloud-backup/setup-upgrade.ps1", import.meta.url))
      const lines = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).split(/\r?\n/).filter((line) => line.startsWith("{"))
      setupScenarios = new Map(lines.map((line) => JSON.parse(line) as SetupScenario).map((run) => [run.scenario, run]))
    }
    return setupScenarios.get(name)!
  }
  const DELETE_ADVICE = "Delete the vault once no"

  it.runIf(Boolean(pwsh))("keeps the change report level and actors on a rerun without their parameters, and sets them when passed", () => {
    // An upgrade with a command that does not carry the change report choice keeps it.
    expect(setupRun("rerun-keeps-report")).toMatchObject({ error: null, changeReport: "names", changeReportActors: "false", tenantName: "Contoso" })
    // An empty -TenantName clears the saved name to the tenant id, never to an empty value.
    expect(setupRun("rerun-sets-report")).toMatchObject({ error: null, changeReport: "full", changeReportActors: "true", tenantName: "11111111-2222-3333-4444-555555555555" })
    expect(setup).toContain('$changeReportPassed = $PSBoundParameters.ContainsKey("ChangeReport")')
    expect(setup).toContain('$changeReportActorsPassed = $PSBoundParameters.ContainsKey("ChangeReportWithoutActors")')
  }, 60_000)

  it.runIf(Boolean(pwsh))("pauses a linked schedule before grants and checks access before publication and resumption", () => {
    const approved = setupRun("linked-upgrade")
    expect(approved).toMatchObject({ error: null, enabled: true, link: true })
    expect(approved.actions).toEqual([
      "schedule enabled=False", "import probe", "publish probe", "canary propagation", "remove probe",
      "import confirm=False", "publish", "export Published", "canary published", "remove TenuVaultKeyVault-11111111",
      "schedule enabled=True",
    ])
    expect(setup.indexOf("-Name $scheduleName -IsEnabled $false")).toBeLessThan(setup.indexOf('Assign the create-only audit role to the managed identity'))
    const propagation = setupRun("propagation-denied")
    expect(propagation).toMatchObject({ error: expect.stringContaining("The schedule is paused"), enabled: false, link: true })
    expect(propagation.actions).not.toContain("publish")
    const canary = setupRun("published-canary-denied")
    expect(canary).toMatchObject({ error: expect.stringContaining("Enable the schedule in Azure after AUDITCANARY passes"), enabled: false, link: true })
    expect(canary.actions).toContain("publish")
    expect(canary.actions).not.toContain("schedule enabled=True")
  }, 60_000)

  it.runIf(Boolean(pwsh))("keeps the Everything scope and existing exclusions when only account and tenant are supplied", () => {
    expect(setupRun("linked-upgrade")).toMatchObject({
      scope: "everything", exclusions: "ConfigurationPolicies,Apps", appOnlyExcluded: "",
    })
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
    // The vault assignment is gone; the two writer assignments on the containers remain.
    expect(template.resources.filter((resource) => resource.type === "Microsoft.Authorization/roleAssignments")).toHaveLength(3)
  })

  it("links the schedule with TENANTKEY only, writes no account id and grants nothing on the Automation account", () => {
    const resources = template.resources as unknown as Array<{ type: string; scope?: string; properties: Record<string, unknown> }>
    const jobSchedule = resources.find((resource) => resource.type === "Microsoft.Automation/automationAccounts/jobSchedules")!
    expect(jobSchedule.properties.parameters).toEqual({ TenantKey: "[variables('tenantKey')]" })
    expect(resources.filter((resource) => resource.type === "Microsoft.Authorization/roleAssignments").every((resource) => resource.scope?.startsWith("[concat('Microsoft.Storage/storageAccounts/"))).toBe(true)
    const text = JSON.stringify(template)
    for (const absent of ["TenuVaultAutomationAccountId", "TenuVaultScheduleSetsTrigger", "acdd72a7-3385-48ef-bd42-f606fba81ae7", "readerRoleId", "Trigger"]) expect(text, absent).not.toContain(absent)
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
