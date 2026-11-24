import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BackupEngine, type BackupJob, type RunTokens } from "../src/main/backup/engine"
import { notifiedStatus, scheduledResult } from "../src/main/backup/scheduler"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"

/**
 * What a backup of an Intune tenant wrote and reported before the engine learned to read Entra ID
 * and Defender, recorded from the release this work started from (commit d906ad4b). Every run
 * here must still write the same files and the same manifest, and report the same job, scheduler
 * result and retention. Only the fields named in ADDED may appear on top.
 * The policy fingerprints include the explicit expanded arrays returned by the fixture tenant.
 *
 * To record again after an intended change: UPDATE_GOLDEN=1 npx vitest run test/intune-backup-unchanged.test.ts
 */

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"
const GOLDEN = join(import.meta.dirname, "fixtures", "intune-backup-golden")
const NOW = new Date("2026-11-10T02:00:00Z")

/** Fields this work adds; everything else is compared as it was recorded. */
const ADDED = {
  manifest: ["Coverage", "Outcomes"],
  job: ["coverage", "outcomes"],
  results: ["coverage"],
}

const denied = () => Response.json({ error: { code: "Forbidden", message: "Forbidden" } }, { status: 403 })
// A status the engine does not retry, so the run does not wait out its backoff.
const broken = () => Response.json({ error: { code: "BadRequest", message: "Something went wrong" } }, { status: 400 })

/** A small Intune tenant: a paged list, a tenant-wide setting, assignments read apart, and types with nothing in them. */
function fixtureGraph(overrides: Record<string, () => Response> = {}) {
  const pages: Record<string, unknown> = {
    "/beta/deviceManagement/deviceConfigurations": {
      value: [{ id: "dc1", displayName: "Win: BitLocker/Encryption" }],
      "@odata.nextLink": "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations?page=2",
    },
    "/beta/deviceManagement/deviceConfigurations?page=2": { value: [{ id: "dc2", displayName: "Win: BitLocker/Encryption" }] },
    "/beta/deviceManagement/deviceCompliancePolicies": { value: [{ id: "cp1", displayName: "Compliance" }] },
    "/beta/deviceManagement/configurationPolicies": { value: [{ id: "sc1", name: "Settings catalog" }] },
    "/beta/deviceManagement/configurationPolicies/sc1/assignments": { value: [{ id: "sc1_group", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }] },
    "/beta/deviceManagement/deviceManagementScripts": { value: [{ id: "ps1", displayName: "Script" }] },
    "/beta/deviceManagement/roleScopeTags": { value: [{ id: "0", displayName: "Default", isBuiltIn: true }, { id: "7", displayName: "Berlin", isBuiltIn: false }] },
    "/beta/deviceManagement/deviceCategories": { value: [{ id: "cat1", displayName: "Kiosk" }] },
    "/beta/deviceManagement/windowsAutopilotDeviceIdentities": { value: [{ id: "ap-1", serialNumber: "SN-0001", model: "Laptop 7", groupTag: "Sales" }] },
    "/beta/deviceManagement/settings": {
      "@odata.context": "https://graph.microsoft.com/beta/$metadata#deviceManagement/settings",
      deviceComplianceCheckinThresholdDays: 30,
      isScheduledActionEnabled: true,
      secureByDefault: false,
      enhancedJailBreak: false,
      enableLogCollection: true,
    },
  }
  return (url: URL) => {
    const key = url.pathname + url.search
    const override = overrides[key]
    if (override) return override()
    if (key in pages) return Response.json(pages[key])
    if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
    if (url.pathname.endsWith("/assignments")) return Response.json({ value: [] })
    const id = url.pathname.split("/").pop()
    const expansion = url.searchParams.get("$expand")
    const collections = expansion === "settings" ? { settings: [] } : expansion?.startsWith("scheduledActionsForRule")
      ? { assignments: [], scheduledActionsForRule: [] } : expansion === "assignments" ? { assignments: [] } : {}
    return Response.json({ "@odata.context": "ctx", ...collections, id, displayName: `Object ${id}`, detail: true })
  }
}

interface Scenario {
  name: string
  graph: ReturnType<typeof fixtureGraph>
  trigger?: "manual" | "scheduled"
  /** The Backup Reader's tokens, for a scheduled run without the admin's sign-in. */
  reader?: RunTokens
}

const SCENARIOS: Scenario[] = [
  { name: "complete", graph: fixtureGraph() },
  // The app registration was never consented for scripts: the type is denied in every backup.
  { name: "denied-type", graph: fixtureGraph({ "/beta/deviceManagement/deviceManagementScripts": denied }), trigger: "scheduled" },
  {
    name: "warnings",
    graph: fixtureGraph({
      "/beta/deviceManagement/deviceConfigurations/dc2?$expand=assignments": broken,
      "/beta/deviceManagement/deviceCategories": broken,
    }),
    trigger: "scheduled",
  },
  {
    name: "backup-reader",
    graph: fixtureGraph(),
    trigger: "scheduled",
    reader: { mode: "app-only", graph: async () => "reader", storage: async () => "reader", excludedTypes: async () => ["DeviceCategories", "DeviceCleanupRules"] },
  },
]

/**
 * Older backups of the tenant: one past the retention period that holds every type, and one inside
 * it that was denied the scripts. A backup that is denied them too must keep the first one.
 */
const OLDER = [
  { folder: "backup-2026-09-01-020000", skipped: [] },
  { folder: "backup-2026-11-05-020000", skipped: ["PowerShellScripts"] },
]

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex")
const without = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
/** Log lines start with the local time of day, which differs between machines. */
const logLine = (line: string) => line.replace(/^\[\d{2}:\d{2}:\d{2}\] /, "")

async function run(scenario: Scenario) {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-golden-")), [randomBytes(32)])
  const account = localStorageAccountName(TENANT)
  await store.createContainer(account, "intune-backups")
  for (const { folder, skipped } of OLDER) {
    const metadata = { BackupFolder: folder, Status: "Success", Failures: 0, TenantId: TENANT, Scope: { Excluded: [], Included: INTUNE_TYPES.map((type) => type.folder) }, SkippedTypes: skipped, FailedTypes: [] }
    await store.put(account, "intune-backups", `${folder}/metadata.json`, Buffer.from(JSON.stringify(metadata)), "application/json")
    await store.put(account, "intune-backups", `${folder}/CompliancePolicies/Compliance.json`, Buffer.from("{}"), "application/json")
  }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    return localAccountFromUrl(url) ? handleLocalBlobRequest(store, request) : scenario.graph(url)
  }) as typeof fetch
  // One reader at a time, so the log and the per type results come in the same order on every machine.
  const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, now: () => NOW, concurrency: 1, unattendedTokens: () => scenario.reader ?? null })
  const started = engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, trigger: scenario.trigger })
  const job: BackupJob = await engine.waitForJob(started)

  const files: Record<string, string> = {}
  let manifest: Record<string, unknown> = {}
  for (const blob of await store.list(account, "intune-backups")) {
    if (!blob.name.startsWith(`${job.backupFolder}/`)) continue
    const { data } = await store.get(account, "intune-backups", blob.name)
    const name = blob.name.slice(job.backupFolder!.length + 1)
    if (name === "metadata.json") manifest = JSON.parse(data.toString()) as Record<string, unknown>
    else files[name] = name === BACKUP_OWNER_FILE ? data.toString().replace(job.id, "<run>") : sha(data)
  }
  const folders = [...new Set((await store.list(account, "intune-backups")).map((blob) => blob.name.split("/")[0]!))].sort()
  const results = job.results ? without(job.results as unknown as Record<string, unknown>, ADDED.results) : undefined
  return {
    manifestText: JSON.stringify({ ...without(manifest, ADDED.manifest), RunId: "<run>" }, null, 2),
    added: Object.keys(manifest).filter((key) => ADDED.manifest.includes(key)),
    record: {
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
      job: { ...without(job as unknown as Record<string, unknown>, ["id", ...ADDED.job]), log: job.log.map(logLine), results },
      scheduled: scheduledResult(job),
      // The status a finished backup is notified with. It was recorded from the expression main/index.ts held before it got a name.
      notification: notifiedStatus(job),
      backupFolders: folders,
    },
  }
}

describe("a backup of an Intune tenant", () => {
  for (const scenario of SCENARIOS) {
    it(`writes and reports what it did before the update: ${scenario.name}`, async () => {
      const { manifestText, record } = await run(scenario)
      const manifestFile = join(GOLDEN, `${scenario.name}.metadata.json`)
      const recordFile = join(GOLDEN, `${scenario.name}.run.json`)
      if (process.env.UPDATE_GOLDEN) {
        mkdirSync(GOLDEN, { recursive: true })
        writeFileSync(manifestFile, manifestText)
        writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`)
      }
      expect(existsSync(manifestFile), "record the golden files first").toBe(true)
      // Byte for byte: key order and formatting included.
      expect(manifestText).toBe(readFileSync(manifestFile, "utf8"))
      expect(JSON.parse(JSON.stringify(record))).toEqual(JSON.parse(readFileSync(recordFile, "utf8")))
    })
  }
})
