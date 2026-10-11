import { assertStorageAccountName } from "../../shared/storage-account"
export { assertStorageAccountName } from "../../shared/storage-account"
import { createHash, randomUUID } from "node:crypto"
import { BACKUP_CONTAINER } from "../../shared/constants"
import { isLocalAccount } from "../storage/blob-emulator"
import { INTUNE_TYPES, itemName, type IntuneType, type Item } from "../../shared/intune/registry"
import { readObject } from "../../shared/intune/read"
import { comparableSnapshot } from "../../shared/intune/compare"
import type { BackupItems } from "../../shared/intune/backup-changes"
import { coveredFolders, EVERYTHING, includedTypes, normalizeScope, type BackupScope } from "../../shared/intune/scope"

/**
 * Runs Intune backups from the desktop app as the signed-in admin.
 *
 * Output matches the TenuVault Azure Automation runbook (folder layout and metadata.json), so the
 * shared restore, drift detection, download and history features work the same for
 * backups made by the app and by the Azure Automation runbook. The destination is the
 * tenant's storage account: either the customer's Azure storage account or the
 * encrypted store on this device (served through the fetch bridge).
 */

export type BackupStatus = "Running" | "Completed" | "Failed"

export interface BackupJob {
  id: string
  tenantId: string
  storageAccountName: string
  status: BackupStatus
  progress: number
  progressMessage: string
  startTime: string
  endTime?: string
  exception?: string
  backupFolder?: string
  log: string[]
}

export type BackupTrigger = "manual" | "scheduled" | "tray"

export interface BackupRequest {
  tenantId: string
  clientId: string
  storageAccountName: string
  /** What to back up; everything when left out. */
  scope?: BackupScope
  trigger?: BackupTrigger
}

export interface BackupEngineDeps {
  /** The main-process fetch (bridged, so local storage accounts are served from disk). */
  fetch: typeof fetch
  getToken: (tenantId: string, clientId: string, scope: string) => Promise<string>
  /** Backups older than this many days are deleted after each backup; 0 keeps everything. */
  retentionDays?: (tenantId: string) => number
  now?: () => Date
  /** Items read at the same time. Graph throttling (429) pauses every reader. */
  concurrency?: number
}

type GraphItem = Record<string, unknown> & { id: string }

const GRAPH = "https://graph.microsoft.com"
/** Far above any real listing; stops a storage service that keeps returning continuation markers. */
const MAX_LIST_PAGES = 10_000

/** A Graph beta path, or an absolute nextLink that must be on the Graph origin. */
function graphUrl(path: string): string {
  if (!URL.canParse(path)) return `${GRAPH}/beta/${path}`
  if (new URL(path).origin !== GRAPH) throw new Error("Invalid Graph continuation link")
  return path
}

/** Types covered by the original DeviceManagementConfiguration permission. */
const ORIGINAL_FOLDERS = new Set(["DeviceConfigurations", "CompliancePolicies", "ConfigurationPolicies", "GroupPolicyConfigurations"])

const listUrl = (type: IntuneType) => `${GRAPH}/beta/${type.path}${type.listQuery ? `?${type.listQuery}` : ""}`

const MAX_JOBS = 25
const CONCURRENCY = 8

/**
 * The storage provider refused a delete because the blob is protected by an immutability
 * policy or a legal hold (for example 409 BlobImmutableDueToPolicy or
 * BlobImmutableDueToLegalHold). Retention treats the backup as protected and kept; it never
 * tries to weaken the policy or remove the hold.
 */
export class ProtectedBlobError extends Error {
  constructor(readonly code: string) {
    super(`The storage provider protects this backup (${code}).`)
    this.name = "ProtectedBlobError"
  }
}

/** Whether a rejected delete is an immutability or legal hold refusal rather than an access or network problem. */
export function isImmutabilityRefusal(status: number, code: string): boolean {
  return (status === 409 || status === 403) && /immutab|legalhold/i.test(code)
}

/** Sign-in or license problems affect every request, so they stop the backup instead of becoming per-policy warnings. */
class TokenError extends Error {}

/** A Graph error with its status, so an expired sign-in (401) stops the backup while a missing permission for one type does not. */
class GraphError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function tokenOrStop(get: () => Promise<string>): Promise<string> {
  try {
    return await get()
  } catch (error) {
    throw new TokenError(error instanceof Error ? error.message : String(error))
  }
}

export class BackupEngine {
  private readonly jobs = new Map<string, BackupJob>()
  private readonly running = new Map<string, BackupJob>()

  constructor(private readonly deps: BackupEngineDeps) {}

  get(jobId: string): BackupJob | undefined {
    return this.jobs.get(jobId)
  }

  /** Starts a backup in the background. One backup per tenant runs at a time. */
  start(request: BackupRequest): BackupJob {
    const tenantKey = request.tenantId.toLowerCase()
    const active = this.running.get(tenantKey)
    if (active) return active

    const job: BackupJob = {
      id: `desktop-${randomUUID()}`,
      tenantId: request.tenantId,
      storageAccountName: request.storageAccountName,
      status: "Running",
      progress: 5,
      progressMessage: "Starting backup...",
      startTime: this.now().toISOString(),
      log: [],
    }
    this.jobs.set(job.id, job)
    this.running.set(tenantKey, job)
    this.prune()

    void this.run(job, request)
      .catch((error: unknown) => {
        job.status = "Failed"
        job.exception = error instanceof Error ? error.message : String(error)
        job.progressMessage = "Backup failed"
        this.write(job, `Backup failed: ${job.exception}`)
      })
      .finally(() => {
        job.progress = 100
        job.endTime = this.now().toISOString()
        this.running.delete(tenantKey)
      })
    return job
  }

  private async run(job: BackupJob, request: BackupRequest): Promise<void> {
    const started = this.now()
    const local = isLocalAccount(request.storageAccountName)
    const backupFolder = `backup-${folderTimestamp(started)}`
    job.backupFolder = backupFolder
    this.write(job, `Backing up tenant ${request.tenantId} to ${local ? "this device (encrypted)" : `storage account ${request.storageAccountName}`}.`)
    this.write(job, `Backup folder: ${backupFolder}`)

    const graphToken = () => tokenOrStop(() => this.deps.getToken(request.tenantId, request.clientId, `${GRAPH}/.default`))
    const storageToken = local
      ? async () => ""
      : () => tokenOrStop(() => this.deps.getToken(request.tenantId, request.clientId, "https://storage.azure.com/.default"))

    const storage = new BlobWriter(this.deps.fetch, request.storageAccountName, storageToken)
    await storage.ensureContainer()

    const scope = normalizeScope(request.scope ?? EVERYTHING)
    const types = includedTypes(scope)
    if (scope.excluded.length) this.write(job, `Leaving out ${scope.excluded.length} of ${INTUNE_TYPES.length} types: ${scope.excluded.join(", ")}.`)
    const graph = new GraphSession(this.deps.fetch, graphToken)
    const reader = {
      get: (path: string) => graph.get<Item>(`${GRAPH}/beta/${path}`),
      list: (path: string) => graph.list(graphUrl(path)) as Promise<Item[]>,
    }
    const concurrency = this.deps.concurrency ?? CONCURRENCY

    // List everything first so progress reflects the real amount of work.
    job.progressMessage = "Reading Intune configuration..."
    const counts: Record<string, number> = Object.fromEntries(types.map((type) => [type.folder, 0]))
    const lists: Array<{ type: IntuneType; items: GraphItem[] } | null> = new Array(types.length).fill(null)
    const skippedTypes: string[] = []
    const failedTypes: string[] = []
    let failures = 0
    await pool(types.map((type, index) => ({ type, index })), concurrency, async ({ type, index }) => {
      try {
        const all = await graph.list(listUrl(type))
        const items = all.filter((item) => !type.skip?.(item as never))
        const skipped = all.length - items.length
        this.write(job, `Found ${items.length} ${type.label}${skipped ? ` (${skipped} built-in skipped)` : ""}.`)
        lists[index] = { type, items }
      } catch (error) {
        if (error instanceof TokenError || (error instanceof GraphError && error.status === 401)) throw error
        // Access denied: the app registration lacks the permission or its admin consent (for example
        // one created before the type was supported), or the admin's Intune role does not cover the
        // type. It is left out and reported, without marking the backup incomplete for the rest.
        if (error instanceof GraphError && error.status === 403 && !ORIGINAL_FOLDERS.has(type.folder)) {
          skippedTypes.push(type.folder)
          this.write(job, `Skipped ${type.label}: access was denied. The app registration may lack the permission or admin consent, or your Intune role may not allow it.`)
          return
        }
        failures++
        failedTypes.push(type.folder)
        this.write(job, `Could not read ${type.label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // File names are chosen in list order, before the parallel reads, so they do not depend on timing.
    const work: Array<{ type: IntuneType; item: GraphItem; displayName: string; fileName: string }> = []
    for (const list of lists) {
      if (!list) continue
      const usedNames = new Set<string>()
      for (const item of list.items) {
        const displayName = itemName(list.type, item as never)
        work.push({ type: list.type, item, displayName, fileName: uniqueName(safeFileName(displayName), item.id, usedNames) })
      }
    }
    const remaining = new Map(lists.filter((list) => list !== null).map((list) => [list.type.folder, list.items.length]))
    const items: BackupItems = {}
    let done = 0

    await pool(work, concurrency, async ({ type, item, displayName, fileName }) => {
      job.progressMessage = `Backing up ${type.label}`
      try {
        const detail = await readObject(type, item.id, reader)
        const body = JSON.stringify(detail, null, 2)
        await storage.put(`${backupFolder}/${type.folder}/${fileName}.json`, body)
        items[`${type.folder}/${item.id}`] = {
          file: `${fileName}.json`,
          hash: snapshotHash(detail),
          // What versions that could not read this type's assignments recorded, to compare with their backups.
          ...(type.assignmentsFormerlyExpanded ? { hashWithEmptyAssignments: snapshotHash({ ...detail, assignments: [] }) } : {}),
        }
        counts[type.folder]!++
      } catch (error) {
        // An expired sign-in fails every remaining item the same way, so it stops the backup once.
        if (error instanceof TokenError || (error instanceof GraphError && error.status === 401)) throw error
        failures++
        this.write(job, `Could not back up "${displayName}": ${error instanceof Error ? error.message : String(error)}`)
      }
      done++
      job.progress = Math.round(10 + (done / Math.max(work.length, 1)) * 85)
      const left = remaining.get(type.folder)! - 1
      remaining.set(type.folder, left)
      if (left === 0) this.write(job, `Backed up ${counts[type.folder]} ${type.label}.`)
    })

    const ended = this.now()
    const seconds = Math.round((ended.getTime() - started.getTime()) / 1000)
    const totalPolicies = Object.values(counts).reduce((sum, count) => sum + count, 0)
    const metadata = {
      BackupDate: folderTimestamp(started),
      BackupFolder: backupFolder,
      StartTime: displayTime(started),
      EndTime: displayTime(ended),
      Duration: seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
      DurationSeconds: seconds,
      ItemCounts: { ...counts, TotalPolicies: totalPolicies },
      Status: failures > 0 ? (totalPolicies === 0 ? "Failed" : "CompletedWithWarnings") : "Success",
      RunbookVersion: "desktop",
      BackupFormat: "Individual policy files with Intune-compatible JSON",
      Source: "TenuVault Desktop",
      // Retention only ever removes backups recorded as this tenant's.
      TenantId: request.tenantId.toLowerCase(),
      Trigger: request.trigger ?? "manual",
      Scope: { Excluded: scope.excluded },
      Failures: failures,
      SkippedTypes: skippedTypes,
      FailedTypes: failedTypes,
      // Per item fingerprints (by type folder and Intune ID), so backups can be compared without reading every file.
      Items: sortKeys(items),
    }
    await storage.put(`${backupFolder}/metadata.json`, JSON.stringify(metadata, null, 2))

    // Only a complete backup may replace older ones: if policies could not be read (for
    // example after a permission change), keep every existing backup.
    let retentionWarning: string | null = null
    if (failures === 0) {
      retentionWarning = await this.applyRetention(job, storage, backupFolder, coveredFolders(metadata)).catch((error: unknown) => {
        this.write(job, `Could not remove old backups: ${error instanceof Error ? error.message : String(error)}`)
        return `Retention paused: ${error instanceof Error ? error.message : String(error)}`
      })
    } else {
      this.write(job, "Older backups were kept because this backup is incomplete.")
    }

    job.status = failures > 0 && totalPolicies === 0 ? "Failed" : "Completed"
    job.progressMessage =
      job.status === "Failed" ? "Backup failed: no policies could be saved" : failures > 0 ? `Backup completed with ${failures} warning${failures === 1 ? "" : "s"}` : "Backup completed successfully"
    if (retentionWarning) job.progressMessage = `Backup completed with a warning. ${retentionWarning}`
    this.write(job, `Backup completed: ${totalPolicies} policies in ${metadata.Duration}.`)
  }

  /**
   * Deletes backup folders older than the retention period, never the one just written, and never the
   * newest backup that holds a type the current backup left out: a backup of fewer types must not
   * age out the only copy of the others. Only this tenant's backups are considered: another
   * tenant's backups and backups without readable metadata are never deleted. Backups from
   * versions that did not record the tenant count as this tenant's unless the container also
   * holds a backup recorded as another tenant's.
   */
  private async applyRetention(job: BackupJob, storage: BlobWriter, current: string, covered: Set<string>): Promise<string | null> {
    const days = this.deps.retentionDays?.(job.tenantId) ?? 0
    if (days <= 0) return null
    const cutoff = this.now().getTime() - days * 24 * 60 * 60 * 1000
    const { prefixes, retentionPaused, completenessUnknown } = await storage.list("", "/")
    if (retentionPaused) {
      const reason = completenessUnknown ? "damaged files cannot be attributed to a backup" : "the backup folder contains damaged files or unavailable backups"
      const warning = `Retention paused because ${reason}. Older backups were kept. Recover or remove the reported damage before retention can continue.`
      this.write(job, warning)
      return warning
    }
    const backups = prefixes
      .map((prefix) => {
        const match = /^backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\/$/.exec(prefix)
        if (!match || prefix === `${current}/`) return null
        const [, y, mo, d, h, mi, se] = match.map(Number) as number[]
        return { prefix, time: Date.UTC(y!, mo! - 1, d!, h!, mi!, se!) }
      })
      .filter((backup) => backup !== null)
      .sort((a, b) => b.time - a.time)

    // Who each backup belongs to. Every metadata file is read first, because backups from versions
    // that did not record the tenant count as this tenant's only while no backup names another one.
    const tenant = job.tenantId.toLowerCase()
    const owners = new Array<{ metadata: Record<string, unknown>; owner: "this" | "other" | "untagged" } | null>(backups.length).fill(null)
    await pool(backups.map((backup, index) => ({ backup, index })), CONCURRENCY, async ({ backup, index }) => {
      const metadata = await storage.readJson(`${backup.prefix}metadata.json`)
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return // Missing or unreadable: never ours.
      const owner = typeof metadata.TenantId !== "string" ? "untagged" : metadata.TenantId.toLowerCase() === tenant ? "this" : "other"
      owners[index] = { metadata, owner }
    })
    const shared = owners.some((entry) => entry?.owner === "other")

    // Types no newer backup holds yet, walking from the newest backup to the oldest.
    const uncovered = new Set(INTUNE_TYPES.map((type) => type.folder).filter((folder) => !covered.has(folder)))
    let removed = 0
    let kept = 0
    let unowned = 0
    let protectedKept = 0
    let partlyRemoved = 0
    for (const [index, backup] of backups.entries()) {
      const entry = owners[index]
      if (!entry || entry.owner === "other" || (entry.owner === "untagged" && shared)) {
        if (backup.time < cutoff) unowned++
        continue
      }
      const metadata = entry.metadata
      let holdsUncovered = false
      const complete = String(metadata.Status).toLowerCase() !== "failed"
      for (const folder of complete ? coveredFolders(metadata) : []) {
        if (uncovered.delete(folder)) holdsUncovered = true
      }
      if (backup.time >= cutoff) continue
      if (holdsUncovered) {
        kept++
        continue
      }
      const { blobs } = await storage.list(backup.prefix)
      // The manifest goes first: a delete that stops at a protected file must not leave a
      // metadata.json that still reports the backup as complete. A protected manifest stops
      // before any policy file is touched.
      const manifest = `${backup.prefix}metadata.json`
      let deleted = 0
      try {
        for (const blob of [...blobs.filter((name) => name === manifest), ...blobs.filter((name) => name !== manifest)]) {
          await storage.delete(blob)
          deleted++
        }
      } catch (error) {
        // Provider retention wins over local retention: the backup stays, and nothing here
        // tries to shorten a policy or clear a hold to make the delete succeed.
        if (!(error instanceof ProtectedBlobError)) throw error
        protectedKept++
        if (deleted > 0) partlyRemoved++
        continue
      }
      removed++
    }
    if (removed > 0) this.write(job, `Removed ${removed} backup${removed === 1 ? "" : "s"} older than ${days} days.`)
    if (kept > 0) this.write(job, `Kept ${kept} older backup${kept === 1 ? "" : "s"} because ${kept === 1 ? "it holds" : "they hold"} the newest copy of types this backup leaves out.`)
    if (protectedKept > 0) {
      this.write(job, `Kept ${protectedKept} older backup${protectedKept === 1 ? "" : "s"} protected by the storage account's immutability policy or legal hold.${partlyRemoved > 0 ? ` ${partlyRemoved} of them lost some files before the protected ones were reached, including ${partlyRemoved === 1 ? "its" : "their"} metadata, so ${partlyRemoved === 1 ? "it is" : "they are"} no longer offered as complete.` : ""}`)
    }
    if (unowned > 0) this.write(job, `Kept ${unowned} older backup${unowned === 1 ? "" : "s"} not recorded as this tenant's (another tenant's, without readable metadata, or from an earlier version in a container another tenant also uses).`)
    return null
  }

  private write(job: BackupJob, line: string): void {
    job.log.push(`[${this.now().toISOString().slice(11, 19)}] ${line}`)
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private prune(): void {
    while (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.values()].find((job) => job.status !== "Running")
      if (!oldest) break
      this.jobs.delete(oldest.id)
    }
  }
}

/** Graph reads for one backup. A throttled request (429) pauses every reader until Graph allows requests again. */
class GraphSession {
  private resumeAt = 0

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly token: () => Promise<string>,
  ) {}

  async list(url: string): Promise<GraphItem[]> {
    const items: GraphItem[] = []
    let next: string | undefined = url
    const seen = new Set<string>()
    while (next) {
      const parsed = new URL(next)
      if (parsed.origin !== GRAPH || !parsed.pathname.startsWith("/beta/") || seen.has(next)) throw new Error("Invalid Graph continuation link")
      seen.add(next)
      const page: { value?: GraphItem[]; "@odata.nextLink"?: string } = await this.get(next)
      if (!Array.isArray(page.value)) throw new Error("Graph returned an invalid policy collection")
      items.push(...page.value)
      next = page["@odata.nextLink"]
    }
    return items
  }

  /** GET with retries for Graph throttling (429) and transient errors (5xx). */
  async get<T = Record<string, unknown>>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.resumeAt - Date.now()
      if (wait > 0) await sleep(wait)
      const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${await this.token()}` } })
      if (response.ok) return (await response.json()) as T
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt >= 4) {
        throw new GraphError(await graphError(response), response.status)
      }
      const retryAfter = Number(response.headers.get("retry-after"))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt
      if (response.status === 429) this.resumeAt = Math.max(this.resumeAt, Date.now() + delay)
      await sleep(delay)
    }
  }
}

/**
 * Runs `task` for every entry with at most `limit` running at once. The first error stops new
 * tasks from starting and is thrown once the running ones have settled.
 */
async function pool<T>(entries: T[], limit: number, task: (entry: T) => Promise<void>): Promise<void> {
  let next = 0
  let failure: { error: unknown } | null = null
  const worker = async () => {
    while (!failure && next < entries.length) {
      const entry = entries[next++]!
      try {
        await task(entry)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker))
  if (failure) throw (failure as { error: unknown }).error
}

/** Fingerprint of a snapshot without the fields Intune changes on every read or write. */
function snapshotHash(detail: Item): string {
  return createHash("sha256").update(JSON.stringify(comparableSnapshot(detail))).digest("base64").slice(0, 22)
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Checks that the signed-in admin can write backups to an Azure storage account:
 * creates the backup container if needed, then writes and deletes a test blob.
 * Throws with an actionable message (for example the missing role) when not.
 */
export async function verifyStorageAccess(
  fetchImpl: typeof fetch,
  storageAccountName: string,
  token: () => Promise<string>,
): Promise<void> {
  const writer = new BlobWriter(fetchImpl, storageAccountName, token)
  await writer.ensureContainer()
  const probe = `.tenuvault-write-test-${randomUUID()}`
  await writer.put(probe, "{}")
  // An immutable container accepts new blobs but keeps them; write access is still proven.
  await writer.delete(probe).catch((error: unknown) => {
    if (!(error instanceof ProtectedBlobError)) throw error
  })
}

/** Writes blobs to Azure or, for local accounts, to the encrypted store via the fetch bridge. */
class BlobWriter {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly account: string,
    private readonly token: () => Promise<string>,
  ) {
    assertStorageAccountName(account)
  }

  async ensureContainer(): Promise<void> {
    const response = await this.request(`${BACKUP_CONTAINER}?restype=container`, { method: "PUT" })
    if (response.ok || response.status === 409) return
    throw new Error(await storageError(response, this.account))
  }

  async put(name: string, body: string): Promise<void> {
    const path = `${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`
    const response = await this.request(path, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/json" },
      body,
    })
    if (!response.ok) throw new Error(await storageError(response, this.account))
  }

  /** Lists blob names and, with a delimiter, virtual folders under a prefix. */
  async list(prefix: string, delimiter = ""): Promise<{ blobs: string[]; prefixes: string[]; retentionPaused: boolean; completenessUnknown: boolean }> {
    const blobs: string[] = []
    const prefixes: string[] = []
    let retentionPaused = false
    let completenessUnknown = false
    let marker = ""
    const seen = new Set<string>()
    do {
      if (seen.size >= MAX_LIST_PAGES) throw new Error(`Storage listing did not finish after ${MAX_LIST_PAGES} pages`)
      const query = new URLSearchParams({ restype: "container", comp: "list", prefix, ...(delimiter ? { delimiter } : {}), ...(marker ? { marker } : {}) })
      const response = await this.request(`${BACKUP_CONTAINER}?${query.toString()}`, { method: "GET" })
      if (response.status === 404) break
      if (!response.ok) throw new Error(await storageError(response, this.account))
      const xml = await response.text()
      retentionPaused ||= xml.includes("<RetentionPaused>true</RetentionPaused>") || xml.includes("<DamagedFile>")
      completenessUnknown ||= xml.includes("<CompletenessUnknown>true</CompletenessUnknown>")
      const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
      for (const m of xml.matchAll(/<BlobPrefix><Name>([^<]*)<\/Name><\/BlobPrefix>/g)) prefixes.push(decode(m[1]!))
      for (const m of xml.matchAll(/<Blob><Name>([^<]*)<\/Name>/g)) blobs.push(decode(m[1]!))
      marker = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? ""
      if (marker && seen.has(marker)) throw new Error("Storage returned a repeated continuation marker")
      seen.add(marker)
    } while (marker)
    return { blobs, prefixes, retentionPaused, completenessUnknown }
  }

  /** A JSON blob, or null when it does not exist or is not valid JSON. */
  async readJson(name: string): Promise<Record<string, unknown> | null> {
    const response = await this.request(`${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`, { method: "GET" })
    if (response.status === 404) return null
    if (response.headers.get("x-ms-error-code") === "IncompleteInventory") return null // Damaged metadata never establishes ownership.
    if (!response.ok) throw new Error(await storageError(response, this.account))
    return (await response.json().catch(() => null)) as Record<string, unknown> | null
  }

  async delete(name: string): Promise<void> {
    const response = await this.request(`${BACKUP_CONTAINER}/${name.split("/").map(encodeURIComponent).join("/")}`, {
      method: "DELETE",
    })
    if (!response.ok && response.status !== 404) {
      const code = response.headers.get("x-ms-error-code") ?? ""
      if (isImmutabilityRefusal(response.status, code)) throw new ProtectedBlobError(code)
      const text = await response.clone().text().catch(() => "")
      const bodyCode = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? ""
      if (isImmutabilityRefusal(response.status, bodyCode)) throw new ProtectedBlobError(bodyCode)
      throw new Error(await storageError(response, this.account))
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const token = await this.token()
    return this.fetchImpl(`https://${this.account}.blob.core.windows.net/${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        "x-ms-version": "2021-12-02",
        "x-ms-date": new Date().toUTCString(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
  }
}

async function graphError(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message
    if (response.status === 403) {
      return `Access denied by Microsoft Graph${message ? `: ${message}` : ""}. Check that your account has an Intune role and the app registration has the Intune permissions.`
    }
    return message ?? `Microsoft Graph returned ${response.status}`
  } catch {
    return `Microsoft Graph returned ${response.status}`
  }
}

async function storageError(response: Response, account: string): Promise<string> {
  if (response.status === 0 || response.type === "error") return `Storage account ${account} could not be reached.`
  const text = await response.text()
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? response.headers.get("x-ms-error-code") ?? ""
  // AuthorizationFailure is the storage firewall or network rules rejecting this computer, not a missing role.
  if (code === "AuthorizationFailure") {
    return `Storage account ${account} rejected the request from this network. Allow this computer's public IP address in the storage account's networking settings, or connect through a network it allows.`
  }
  if (response.status === 403 || code.startsWith("Authorization")) {
    return `You do not have write access to storage account ${account}. Ask an Azure administrator for the "Storage Blob Data Contributor" role on it. New role assignments can take a few minutes to apply.`
  }
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]
  return `Storage account ${account} returned ${response.status}${code ? ` (${code})` : ""}${message ? `: ${message.split("\n")[0]}` : ""}`
}

/** backup-yyyy-MM-dd-HHmmss in UTC, the runbook's folder format. */
function folderTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

function displayTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19)
}

/** Same rules as Get-SafeFileName in the runbook. */
export function safeFileName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || "unnamed"
  )
}

/** Policies can share a display name; keep both instead of overwriting one. */
function uniqueName(name: string, id: string, used: Set<string>): string {
  const key = name.toLowerCase()
  if (!used.has(key)) {
    used.add(key)
    return name
  }
  // Ids can share their first characters (enrollment defaults all start with the same GUID),
  // so fall back to the whole id, then a counter, until the name is free.
  const candidates = [`${name} (${id.slice(0, 8)})`, `${name} (${safeFileName(id)})`]
  let unique = candidates.find((candidate) => !used.has(candidate.toLowerCase()))
  for (let n = 2; !unique; n++) {
    if (!used.has(`${name} (${n})`.toLowerCase())) unique = `${name} (${n})`
  }
  used.add(unique.toLowerCase())
  return unique
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
