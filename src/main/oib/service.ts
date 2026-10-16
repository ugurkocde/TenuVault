import { randomUUID } from "node:crypto"
import { graphCaller, readLive, Restorer, type GraphCall } from "../../portal/lib/policies/graph-restore"
import { INTERNAL_API_ORIGIN } from "../../shared/constants"
import { record, type RecordJson } from "../../shared/frameworks/policies"
import { normalizeBackupStatus } from "../../portal/lib/backup-health"
import { INTUNE_TYPES, typeForFolder, type Item } from "../../shared/intune/registry"
import { normalizeScope } from "../../shared/intune/scope"
import { VALIDATED_FOLDERS, validatePolicy } from "../../shared/oib/compare"
import { extractOibId } from "../../shared/oib/manifest"
import { compareToTenant } from "../../shared/oib/match"
import { replaceTenantVariables } from "../../shared/oib/variables"
import { isFullValidation, OIB_BACKUP_REUSE_MINUTES, OIB_PLATFORMS, type DeployItem, type OibBackupChoice, type OibBackupOptions, type OibComparison, type OibPlatform, type OibProgress, type OibRecentBackup, type OibRun, type PolicyValidation, type TenantPolicy, type UndoResult, type ValidationRun } from "../../shared/oib/types"
import { backupGaps, describeMissing, describeStatus, folderLabel } from "../backup/completeness"
import { apiBody } from "../features/deps"
import { withTenantWrite } from "../features/write-lock"
import { backupBeforeWrite } from "../backup/before-write"
import type { KeyValueStore } from "../storage/secure-store"
import { FrameworkError, tokenFor } from "../frameworks/service"
import { loadPack, oibDownloads, oibVersions, resolveMain, type LoadedPack } from "./source"

/**
 * OpenIntuneBaseline deployments, comparison and validation (the OIBDeployer flows).
 *
 * Deployments can back the tenant up first, create policies under their OIB names (unassigned unless
 * a pilot group is given) and update outdated policies in place without touching their assignments.
 * Every run keeps the IDs it created and the previous version of everything it updated, so it can be
 * undone. Comparison and validation only read the tenant.
 */

const GRAPH_BETA = "https://graph.microsoft.com/beta/"
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OBJECT_ID = /^[A-Za-z0-9_-]{1,100}$/
const RUNS_KEPT = 20
const VALIDATIONS_KEPT = 50
const MAX_HISTORY_CHARS = 16_000_000
const MAX_INVENTORY_PAGES = 1000
/** Backup folder names the backup routes write (and the dated folders of older versions). */
const BACKUP_FOLDER = /^(backup-\d{4}-\d{2}-\d{2}-\d{6}|\d{4}-\d{2}-\d{2})$/
/** Newest finished backups inspected for reuse; older ones are past the reuse window in practice. */
const RECENT_CANDIDATES = 3
/** Polling of the pre-change backup; tests shorten it. */
export const OIB_BACKUP_POLLING = { intervalMs: 2000 }
/** Graph answers a driver update profile create with a bare 403 when the tenant lacks the Windows Autopatch entitlement. */
const DRIVER_LICENSE_NOTE = "Driver update profiles need a Windows license with the Autopatch entitlement (Microsoft 365 Business Premium, E3, E5, F3, A3 or A5)."
const failure = (folder: string, error: string) =>
  folder === "DriverUpdateProfiles" && /^An error has occurred|forbidden/i.test(error) ? `${error.replace(/\.?\s*$/, ".")} ${DRIVER_LICENSE_NOTE}` : error

let store: KeyValueStore | null = null
const progress = new Map<string, OibProgress>()

/** The encrypted app store that keeps runs and validation history; set once at startup. */
export function setOibStore(value: KeyValueStore | null): void {
  store = value
}

/** The commit Quick Start deployed when no other release was chosen. */
const QUICKSTART_PINNED_COMMIT = "616c4de853f975819f4d1106dc92fe620f4c78d6"

/**
 * Moves Quick Start runs (earlier versions) into the OpenIntuneBaseline history, so the policies
 * they created can still be undone here and recorded as installed baselines. Run IDs are kept.
 * The original records stay under quickstart:migrated:<tenant>; nothing is deleted. Saved OIB
 * framework workspaces are left untouched.
 */
export function migrateLegacyOibRuns(target: { keys(): string[]; get(key: string): string | null; set(key: string, value: string): void; delete(key: string): void }): void {
  for (const key of target.keys()) {
    if (!key.startsWith("quickstart:runs:")) continue
    const tenant = key.slice("quickstart:runs:".length)
    const text = target.get(key)
    let legacy: unknown
    try {
      legacy = JSON.parse(text ?? "[]")
    } catch {
      // Unreadable records are kept as they are rather than dropped.
      continue
    }
    if (!Array.isArray(legacy)) continue
    let existing: OibRun[] = []
    try {
      const parsed: unknown = JSON.parse(target.get(runsKey(tenant)) ?? "[]")
      if (Array.isArray(parsed)) existing = parsed as OibRun[]
    } catch {
      continue
    }
    const migrated = legacy.filter(record).flatMap((run): OibRun[] => {
      if (typeof run.runId !== "string" || !Array.isArray(run.created) || !run.created.length || existing.some((entry) => entry.runId === run.runId)) return []
      const platform = typeof run.platform === "string" && Object.hasOwn(OIB_PLATFORMS, run.platform) ? (run.platform as OibPlatform) : null
      if (!platform) return []
      const reference = typeof run.reference === "string" ? run.reference : "OpenIntuneBaseline Quick Start"
      const short = /([0-9a-f]{7})\s*$/.exec(reference)?.[1]
      return [{
        runId: run.runId, tenantId: tenant, createdAt: typeof run.createdAt === "string" ? run.createdAt : new Date(0).toISOString(), kind: "deploy", platform, reference,
        ...(short && QUICKSTART_PINNED_COMMIT.startsWith(short) ? { commit: QUICKSTART_PINNED_COMMIT } : {}), legacy: "quickstart",
        ...(typeof run.backupFolder === "string" ? { backupFolder: run.backupFolder } : {}), ...(typeof run.pilotGroupId === "string" ? { pilotGroupId: run.pilotGroupId } : {}),
        created: run.created.filter(record).flatMap((item) => typeof item.folder === "string" && typeof item.id === "string" && typeof item.name === "string"
          ? [{ folder: item.folder, id: item.id, name: item.name, ...(item.partial === true ? { partial: true } : {}), ...(Array.isArray(item.warnings) ? { warnings: item.warnings.map(String) } : {}) }] : []),
        updated: [], failed: Array.isArray(run.failed) ? run.failed.filter(record).map((entry) => ({ name: String(entry.name ?? ""), error: String(entry.error ?? "") })) : [],
        skipped: Array.isArray(run.skipped) ? run.skipped.filter(record).map((entry) => ({ name: String(entry.name ?? ""), reason: "Already in the tenant." })) : [],
      }]
    })
    const runs = [...migrated, ...existing].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    // Written before the legacy key moves, so an interrupted start migrates again next time.
    if (migrated.length) target.set(runsKey(tenant), JSON.stringify(runs))
    target.set(`quickstart:migrated:${tenant}`, text ?? "[]")
    target.delete(key)
  }
}

function platformOf(value: unknown): OibPlatform {
  if (typeof value !== "string" || !Object.hasOwn(OIB_PLATFORMS, value)) throw new FrameworkError("Choose a supported OpenIntuneBaseline platform.")
  return value as OibPlatform
}

function tenantOf(value: unknown): string {
  if (typeof value !== "string" || !GUID.test(value)) throw new FrameworkError("Select a signed-in tenant first.")
  return value.toLowerCase()
}

function requireStore(): KeyValueStore {
  if (!store) throw new FrameworkError("OpenIntuneBaseline history is not available.", 500)
  return store
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Tenant policies of the given registry folders, with the OIBID from each description. */
async function inventory(graph: GraphCall, folders: string[]): Promise<TenantPolicy[]> {
  const result: TenantPolicy[] = []
  for (const folder of new Set(folders)) {
    const type = typeForFolder(folder)
    if (!type) continue
    let next: string | undefined = `${type.path}?$select=id,${type.nameKey},description`
    // Settings Catalog pages hold 25 policies; a listing cut short would report deployed policies as missing.
    for (let page = 0; next; page++) {
      if (page >= MAX_INVENTORY_PAGES) throw new FrameworkError(`Tenant ${type.label} could not be read completely (more than ${MAX_INVENTORY_PAGES} pages).`, 502)
      const response = await graph("GET", next)
      if (response.status >= 300) throw new FrameworkError(`Tenant ${type.label} could not be read (${response.status}).`, response.status === 403 ? 403 : 502)
      for (const entry of Array.isArray(response.body.value) ? (response.body.value as Item[]) : []) {
        const name = entry[type.nameKey]
        if (typeof entry.id === "string" && typeof name === "string") result.push({ id: entry.id, name, folder, oibId: extractOibId(entry.description) })
      }
      const link = response.body["@odata.nextLink"]
      next = typeof link === "string" && link.startsWith(GRAPH_BETA) ? link.slice(GRAPH_BETA.length) : undefined
    }
  }
  return result
}

const packFolders = (pack: LoadedPack) => [...new Set([...pack.items.values()].map((item) => item.folder))]

async function compare(body: RecordJson): Promise<OibComparison> {
  const platform = platformOf(body.platform)
  const tenant = tenantOf(body.tenantId)
  const pack = await loadPack(platform, body.commit, body.tag)
  const { token } = await tokenFor(body)
  const tenantPolicies = await inventory(graphCaller(token), packFolders(pack))
  const { matches, deprecated } = compareToTenant(pack.catalog.policies, pack.catalog.deprecated, tenantPolicies)
  return {
    tenantId: tenant, platform, commit: pack.catalog.commit, reference: pack.catalog.reference,
    comparedAt: new Date().toISOString(), tenantPolicyCount: tenantPolicies.length, matches, deprecated,
  }
}

// Runs

const runsKey = (tenant: string) => `oib:runs:${tenant}`

function readRuns(tenant: string): OibRun[] {
  try {
    const runs: unknown = JSON.parse(requireStore().get(runsKey(tenant)) ?? "[]")
    return Array.isArray(runs) ? (runs as OibRun[]) : []
  } catch {
    return []
  }
}

/**
 * Saves a run, replacing an earlier version of it; a run with nothing left to undo is removed.
 * The latest RUNS_KEPT runs are kept within MAX_HISTORY_CHARS. Runs migrated from Quick Start
 * are outside that limit: they are small (IDs only) and are the only record of what those
 * deployments created, so they stay until they are undone.
 */
function saveRun(run: OibRun): void {
  let runs = readRuns(run.tenantId).filter((r) => r.runId !== run.runId)
  if (run.created.length || run.updated.length) runs.push(run)
  const legacy = runs.filter((r) => r.legacy === "quickstart")
  let recent = runs.filter((r) => r.legacy !== "quickstart").slice(-RUNS_KEPT)
  const combine = () => [...legacy, ...recent].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  let json = JSON.stringify(combine())
  while (json.length > MAX_HISTORY_CHARS && recent.length > 1) {
    recent = recent.slice(1)
    json = JSON.stringify(combine())
  }
  requireStore().set(runsKey(run.tenantId), json)
}

/** A run without the saved previous versions, which stay in the main process. */
function publicRun(run: OibRun): OibRun {
  return { ...run, updated: run.updated.map(({ before: _before, ...rest }) => rest) }
}

export function listRuns(tenantId: unknown): OibRun[] {
  return readRuns(tenantOf(tenantId)).reverse().map(publicRun)
}

const post = async (path: string, payload: Record<string, unknown>) => {
  const response = await fetch(`${INTERNAL_API_ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
  const json: unknown = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, json: record(json) ? json : {} }
}

const errorText = (json: RecordJson) => (typeof json.details === "string" ? json.details : typeof json.error === "string" ? json.error : "")

/** The body for the app's storage routes, with the tenant's delegated credentials (see apiBody). */
const storageBody = (body: RecordJson, tenant: string, extra: Record<string, unknown> = {}) => apiBody(tenant, { clientId: String(body.appId ?? ""), storageAccountName: String(body.storageAccountName ?? "") }, extra)

const hasStorage = (body: RecordJson) => typeof body.storageAccountName === "string" && !!body.storageAccountName && typeof body.appId === "string" && !!body.appId

/** Registry folders a request names, each exactly as the registry spells it. */
function foldersOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > INTUNE_TYPES.length) throw new FrameworkError("Name the policy types the deployment writes.")
  const folders = [...new Set(value)]
  if (!folders.every((folder) => typeof folder === "string" && typeForFolder(folder)?.folder === folder)) throw new FrameworkError("Unknown policy type.")
  return folders as string[]
}

function backupChoice(value: unknown): OibBackupChoice {
  if (value === undefined || value === true) return { mode: "new" }
  if (value === false) return { mode: "none" }
  if (record(value)) {
    if (value.mode === "new" || value.mode === "none") return { mode: value.mode }
    if (value.mode === "reuse" && typeof value.folder === "string" && BACKUP_FOLDER.test(value.folder)) return { mode: "reuse", folder: value.folder }
  }
  throw new FrameworkError("Choose whether to back up now, reuse a recent backup or skip the backup.")
}

interface BackupListing { id: string; timestamp: string; status?: unknown }

/** This tenant's backups, newest first, through the app's own listing route. */
async function tenantBackups(body: RecordJson, tenant: string): Promise<BackupListing[]> {
  const listed = await post("/api/list-backups", storageBody(body, tenant))
  if (!listed.ok) throw new FrameworkError(`The backups of this tenant could not be listed. ${errorText(listed.json)}`.trim(), listed.status === 403 ? 403 : 502)
  return (Array.isArray(listed.json.backups) ? (listed.json.backups as unknown[]) : [])
    .filter((entry): entry is BackupListing => record(entry) && typeof entry.id === "string" && typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
}

/**
 * How a listed backup covers the given folders, from its metadata.json. Null when the backup is not
 * recorded as this tenant's: backups from versions that did not record the tenant are never reused.
 */
async function inspectBackup(body: RecordJson, tenant: string, backup: BackupListing, folders: string[]): Promise<OibRecentBackup | null> {
  const contents = await post("/api/list-backup-contents", storageBody(body, tenant, { backupId: backup.id }))
  if (!contents.ok) throw new FrameworkError(`The backup ${backup.id} could not be read. ${errorText(contents.json)}`.trim(), 502)
  const metadata = record(contents.json.content) ? contents.json.content.metadata : undefined
  if (!record(metadata) || typeof metadata.TenantId !== "string" || metadata.TenantId.toLowerCase() !== tenant) return null
  const gaps = backupGaps(metadata, folders)!
  const duration = typeof metadata.DurationSeconds === "number" && metadata.DurationSeconds > 0 ? metadata.DurationSeconds * 1000 : 0
  const completed = Date.parse(backup.timestamp) + duration
  const reason = [gaps.succeeded ? "" : `The backup is not complete (${describeStatus(gaps)}).`, gaps.missing.length ? `${describeMissing(gaps)}.` : ""].filter(Boolean).join(" ")
  return {
    folder: backup.id, completedAt: new Date(completed).toISOString(), ageMinutes: Math.max(0, Math.floor((Date.now() - completed) / 60_000)),
    complete: gaps.succeeded && !gaps.missing.length, missing: gaps.missing.flatMap((entry) => entry.folders).map(folderLabel), ...(reason ? { reason } : {}),
  }
}

/** The newest finished backup of the tenant, for the backup choice before a deployment or fix. */
async function backupOptions(body: RecordJson): Promise<OibBackupOptions> {
  const tenant = tenantOf(body.tenantId)
  const folders = foldersOf(body.folders)
  if (!hasStorage(body)) return { recent: null }
  const finished = (await tenantBackups(body, tenant)).filter((backup) => !["running", "incomplete"].includes(normalizeBackupStatus(backup)))
  for (const backup of finished.slice(0, RECENT_CANDIDATES)) {
    // A backup that cannot be read is passed over, like one recorded for another tenant.
    const recent = await inspectBackup(body, tenant, backup, folders).catch(() => null)
    if (recent) return { recent }
  }
  return { recent: null }
}

/** Accepts a backup chosen for reuse only after checking it here; nothing the renderer says about it is trusted. */
async function requireReusable(body: RecordJson, tenant: string, folder: string, folders: string[]): Promise<void> {
  const backup = (await tenantBackups(body, tenant)).find((entry) => entry.id === folder)
  const found = backup ? await inspectBackup(body, tenant, backup, folders) : null
  if (!found) throw new FrameworkError(`The backup ${folder} is not recorded as this tenant's backup, so nothing was changed. Back up now instead.`)
  if (!found.complete) throw new FrameworkError(`The backup ${folder} does not hold a complete copy of the policy types this run changes, so nothing was changed. ${found.reason ?? ""} Back up now instead.`.replace(/\s+/g, " ").trim())
  if (found.ageMinutes > OIB_BACKUP_REUSE_MINUTES) throw new FrameworkError(`The backup ${folder} is more than 24 hours old, so nothing was changed. Back up now instead.`)
}

/**
 * Backs up the policy types a run writes through the app's own backup route and waits for it.
 * Returns the backup folder; any failure, or a backup that is not complete for those types,
 * stops the run before a policy changes.
 */
async function backUp(body: RecordJson, tenant: string, folders: string[], report: (update: Partial<OibProgress> & { stage: string }) => void): Promise<string> {
  const scope = normalizeScope({ excluded: INTUNE_TYPES.map((type) => type.folder).filter((folder) => !folders.includes(folder)) })
  return backupBeforeWrite({
    workflow: "oib",
    post: (path, extra) => post(path, path === "/api/list-backup-contents" ? storageBody(body, tenant, extra) : extra),
    startBody: { tenantId: body.tenantId!, appId: body.appId!, storageAccountName: body.storageAccountName!, scope },
    folders,
    now: Date.now,
    polling: { intervalMs: OIB_BACKUP_POLLING.intervalMs, timeoutMs: 60 * 60_000, sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) },
    error: (message, status) => new FrameworkError(message, status),
    report,
  })
}

/** Progress of one running job under its key; every update keeps the job's kind and start time. */
function tracker(key: string, kind: OibProgress["kind"]) {
  const startedAt = new Date().toISOString()
  return (update: Partial<OibProgress> & { stage: string }) => {
    progress.set(key, { done: 0, total: 0, ...update, kind, startedAt })
  }
}

function deployItems(value: unknown, kind: OibRun["kind"]): DeployItem[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new FrameworkError("Select between 1 and 200 policies.")
  if (kind === "fix" && value.length !== 1) throw new FrameworkError("Fix one policy at a time.")
  const sources = new Set<string>()
  const targets = new Set<string>()
  return value.map((entry): DeployItem => {
    if (!record(entry) || typeof entry.source !== "string" || (entry.mode !== "create" && entry.mode !== "update")) throw new FrameworkError("The policy selection is invalid.")
    if (kind === "fix" && entry.mode !== "update") throw new FrameworkError("Fix drift updates an existing policy.")
    if (sources.has(entry.source)) throw new FrameworkError("A policy is selected twice.")
    sources.add(entry.source)
    if (entry.mode === "create") return { source: entry.source, mode: "create" }
    if (typeof entry.targetId !== "string" || !OBJECT_ID.test(entry.targetId)) throw new FrameworkError("Choose the tenant policy to update.")
    if (targets.has(entry.targetId.toLowerCase())) throw new FrameworkError("Two policies would update the same tenant policy.")
    targets.add(entry.targetId.toLowerCase())
    return { source: entry.source, mode: "update", targetId: entry.targetId }
  })
}

async function deploy(body: RecordJson, kind: OibRun["kind"]): Promise<OibRun> {
  const platform = platformOf(body.platform)
  const tenant = tenantOf(body.tenantId)
  const items = deployItems(body.items, kind)
  const pilot = body.pilotGroupId == null || body.pilotGroupId === "" ? undefined : body.pilotGroupId
  if (pilot !== undefined && (kind !== "deploy" || typeof pilot !== "string" || !GUID.test(pilot))) throw new FrameworkError("The pilot group must be an Entra group object ID.")
  // Undo puts back the previous version saved in the run, so an update may skip the backup too.
  const backup = backupChoice(body.backup)
  if (backup.mode !== "none" && !hasStorage(body)) throw new FrameworkError("Choose where backups for this tenant are stored in Settings first, or skip the backup.")
  requireStore()
  return withTenantWrite(tenant, kind === "fix" ? "OpenIntuneBaseline drift fix" : "OpenIntuneBaseline deployment", async () => {
    const report = tracker(tenant, kind)
    try {
      report({ stage: "Loading the OIB pack" })
      const pack = await loadPack(platform, body.commit, body.tag)
      const chosen = items.map((item) => {
        const policy = pack.items.get(item.source)
        if (!policy) throw new FrameworkError(`${item.source} is not part of this OIB pack.`)
        return { ...item, policy, meta: pack.catalog.policies.find((entry) => entry.source === item.source) }
      })
      const { token } = await tokenFor(body)
      const graph = graphCaller(token, fetch, { tenant, refreshToken: async () => (await tokenFor(body, true)).token })
      const written = [...new Set(chosen.map((item) => item.policy.folder))]
      let backupFolder: string | undefined
      if (backup.mode === "new") {
        report({ stage: "Backing up the tenant" })
        backupFolder = await backUp(body, tenant, written, report)
      } else if (backup.mode === "reuse") {
        report({ stage: "Checking the chosen backup" })
        await requireReusable(body, tenant, backup.folder, written)
        backupFolder = backup.folder
      }
      const run: OibRun = {
        runId: randomUUID(), tenantId: tenant, createdAt: new Date().toISOString(), kind, platform, reference: pack.catalog.reference, commit: pack.catalog.commit,
        ...(backupFolder ? { backupFolder } : {}), backupMode: backup.mode, ...(pilot ? { pilotGroupId: pilot.toLowerCase() } : {}), created: [], updated: [], failed: [], skipped: [],
      }
      report({ stage: "Checking existing policies" })
      const creates = chosen.filter((item) => item.mode === "create")
      const existing = creates.length ? await inventory(graphCaller(token), creates.map((item) => item.policy.folder)) : []
      const creator = new Restorer(graph, { mode: "copy", prefix: "", assignments: !!pilot })
      const replacer = new Restorer(graph, { mode: "replace", assignments: false })
      const assignments = pilot ? [{ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: pilot } }] : []
      for (const [index, item] of chosen.entries()) {
        const { policy } = item
        report({ stage: `${item.mode === "create" ? "Creating" : "Updating"} ${policy.name}`, done: index, total: chosen.length })
        const snapshot = replaceTenantVariables(policy.snapshot, tenant)
        const path = `oib/${policy.folder}/${policy.source.split("/").pop()}`
        if (item.mode === "create") {
          // A policy the tenant already has (same OIBID, or same type and name) is left alone rather than duplicated.
          const clash = existing.find((entry) => entry.folder === policy.folder && ((item.meta?.oibId && entry.oibId === item.meta.oibId) || entry.name.toLowerCase() === policy.name.toLowerCase()))
          if (clash) {
            run.skipped!.push({ name: policy.name, reason: `Already in the tenant as ${clash.name}.` })
            continue
          }
          const outcome = await creator.restore(path, { ...snapshot, assignments })
          if (outcome.policyId) {
            run.created.push({ folder: policy.folder, id: outcome.policyId, name: policy.name, ...(outcome.partial ? { partial: true } : {}), ...(outcome.warnings ? { warnings: outcome.warnings } : {}) })
            // Saved after every object, so an interrupted run can still be undone.
            saveRun(run)
          }
          if (!outcome.success) run.failed.push({ name: policy.name, error: failure(policy.folder, outcome.error ?? "Creation failed; check Intune before retrying.") })
        } else {
          const type = typeForFolder(policy.folder)!
          let before: Item | undefined
          try {
            before = await readLive(graph, type, item.targetId!)
          } catch (error) {
            run.failed.push({ name: policy.name, error: `The current policy could not be read, so it was not changed: ${message(error)}` })
            continue
          }
          if (!before) {
            run.failed.push({ name: policy.name, error: "The tenant policy no longer exists. Compare again." })
            continue
          }
          const previous = before[type.nameKey] ?? before.displayName ?? before.name
          // The pack's Default scope tag is for new policies; an update keeps the tenant's own tags.
          const { roleScopeTagIds: _packTags, ...content } = snapshot
          const outcome = await replacer.restore(path, { ...content, ...(Array.isArray(before.roleScopeTagIds) ? { roleScopeTagIds: before.roleScopeTagIds } : {}), id: item.targetId! })
          if (outcome.action === "unchanged") {
            run.skipped!.push({ name: policy.name, reason: "Already matches the baseline." })
            continue
          }
          if (outcome.success || outcome.partial) {
            run.updated.push({ folder: policy.folder, id: item.targetId!, name: policy.name, previousName: typeof previous === "string" ? previous : item.targetId!, before,
              ...(outcome.partial ? { partial: true } : {}), ...(outcome.warnings ? { warnings: outcome.warnings } : {}) })
            saveRun(run)
          }
          if (!outcome.success) run.failed.push({ name: policy.name, error: outcome.error ?? "The update failed; check Intune before retrying." })
        }
      }
      saveRun(run)
      return publicRun(run)
    } finally {
      progress.delete(tenant)
    }
  })
}

/** Deletes the objects a run created and puts back the previous version of what it updated. */
async function undo(body: RecordJson): Promise<UndoResult> {
  const tenant = tenantOf(body.tenantId)
  return withTenantWrite(tenant, "OpenIntuneBaseline undo", async () => {
    const run = readRuns(tenant).find((r) => r.runId === body.runId)
    if (!run) throw new FrameworkError("This run was already undone or is not recorded on this device.", 404)
    const report = tracker(tenant, "undo")
    const total = run.created.length + run.updated.length
    try {
      // No count yet: "1 of 6" would read as if something were being undone.
      report({ stage: "Signing in" })
      const { token } = await tokenFor(body)
      const graph = graphCaller(token, fetch, { tenant, refreshToken: async () => (await tokenFor(body, true)).token })
      const results: UndoResult["results"] = []
      const created: OibRun["created"] = []
      const updated: OibRun["updated"] = []
      for (const item of run.created) {
        report({ stage: `Deleting ${item.name}`, done: results.length, total })
        const type = typeForFolder(item.folder)
        if (!type || !OBJECT_ID.test(item.id)) {
          results.push({ name: item.name, id: item.id, action: "removed", done: false, error: "The recorded object cannot be removed automatically. Delete it in Intune." })
          created.push(item)
          continue
        }
        const response = await graph("DELETE", `${type.path}/${item.id}`)
        // Settings Catalog answers 400 ResourceNotFound for deleted policies instead of 404.
        const gone = response.status < 300 || response.status === 404 || (response.status === 400 && /ResourceNotFound/i.test(JSON.stringify(response.body)))
        if (gone) results.push({ name: item.name, id: item.id, action: "removed", done: true })
        else {
          const error = (response.body.error as Item | undefined)?.message
          results.push({ name: item.name, id: item.id, action: "removed", done: false, error: typeof error === "string" && error ? error : `Microsoft Graph returned ${response.status}` })
          created.push(item)
        }
      }
      const restorer = new Restorer(graph, { mode: "replace", assignments: false })
      for (const item of run.updated) {
        report({ stage: `Restoring ${item.previousName}`, done: results.length, total })
        if (!item.before) {
          results.push({ name: item.previousName, id: item.id, action: "restored", done: false, error: "No previous version was saved for this policy. Restore it from a backup." })
          updated.push(item)
          continue
        }
        const outcome = await restorer.restore(`oib/${item.folder}/${item.id}.json`, item.before)
        if (outcome.success) results.push({ name: item.previousName, id: item.id, action: "restored", done: true })
        else {
          results.push({ name: item.previousName, id: item.id, action: "restored", done: false, error: outcome.error ?? "The previous version could not be put back." })
          updated.push(item)
        }
      }
      const remaining = { ...run, created, updated }
      saveRun(remaining)
      return { run: created.length || updated.length ? publicRun(remaining) : null, results }
    } finally {
      progress.delete(tenant)
    }
  })
}

// Validation

const validationsKey = (tenant: string) => `oib:validations:${tenant}`

function readValidations(tenant: string): ValidationRun[] {
  try {
    const runs: unknown = JSON.parse(requireStore().get(validationsKey(tenant)) ?? "[]")
    return Array.isArray(runs) ? (runs as ValidationRun[]) : []
  } catch {
    return []
  }
}

/**
 * The validations kept within the count and size limits, newest first. The oldest single-policy
 * check goes first; a full validation (Validate all) is only removed when no single-policy check
 * is left, so single checks never push out the validation that sets the OIB score.
 */
export function keepValidations(runs: ValidationRun[], maxRuns = VALIDATIONS_KEPT, maxChars = MAX_HISTORY_CHARS): ValidationRun[] {
  const kept = [...runs]
  const over = () => kept.length > maxRuns || (kept.length > 1 && JSON.stringify(kept).length > maxChars)
  while (over()) {
    let index = kept.length - 1
    while (index >= 0 && isFullValidation(kept[index]!)) index--
    kept.splice(index >= 0 ? index : kept.length - 1, 1)
  }
  return kept
}

/** Saves the history and reports whether the validation with `runId` was kept. */
function saveValidations(tenant: string, runs: ValidationRun[], runId?: string): boolean {
  const kept = keepValidations(runs)
  requireStore().set(validationsKey(tenant), JSON.stringify(kept))
  return runId === undefined || kept.some((run) => run.runId === runId)
}

/**
 * Validates the selected policies. `saved` says whether the result is in Saved validations: a
 * single-policy check is not kept when every retained entry is a full validation, which is never
 * removed to make room for it.
 */
async function validate(body: RecordJson): Promise<ValidationRun & { saved: boolean }> {
  const platform = platformOf(body.platform)
  const tenant = tenantOf(body.tenantId)
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 200) throw new FrameworkError("Select between 1 and 200 matched policies.")
  const targets = body.items.map((entry) => {
    if (!record(entry) || typeof entry.source !== "string" || typeof entry.targetId !== "string" || !OBJECT_ID.test(entry.targetId)) throw new FrameworkError("The policy selection is invalid.")
    return { source: entry.source, targetId: entry.targetId }
  })
  requireStore()
  const pack = await loadPack(platform, body.commit, body.tag)
  const { token } = await tokenFor(body)
  const graph = graphCaller(token)
  const key = `${tenant}:validate`
  const report = tracker(key, "validate")
  const results: PolicyValidation[] = []
  try {
    for (let i = 0; i < targets.length; i += 2) {
      report({ stage: "Validating settings", done: i, total: targets.length })
      results.push(...await Promise.all(targets.slice(i, i + 2).map(async ({ source, targetId }): Promise<PolicyValidation> => {
        const policy = pack.items.get(source)
        const base = { source, name: policy?.name ?? source, folder: policy?.folder ?? "", tenantPolicyId: targetId, tenantPolicyName: targetId }
        if (!policy) return { ...base, status: "error", error: "This policy is not part of the loaded OIB pack." }
        if (!VALIDATED_FOLDERS.includes(policy.folder)) return { ...base, status: "unsupported", error: "This policy type is not validated setting by setting." }
        const wanted = replaceTenantVariables(policy.snapshot, tenant)
        const expectedSettings = validatePolicy(policy.folder, wanted, wanted)?.totalOib
        const countedBase = { ...base, expectedSettings }
        const type = typeForFolder(policy.folder)!
        try {
          const live = await readLive(graph, type, targetId)
          if (!live) return { ...countedBase, status: "error", error: "The tenant policy no longer exists. Compare again." }
          const name = live[type.nameKey] ?? live.displayName ?? live.name
          const result = validatePolicy(policy.folder, wanted, live)!
          return { ...countedBase, tenantPolicyName: typeof name === "string" ? name : targetId, status: result.compliant ? "compliant" : "drifted", result }
        } catch (error) {
          return { ...countedBase, status: "error", error: message(error) }
        }
      })))
    }
  } finally {
    progress.delete(key)
  }
  const selection = body.selection === "single" || body.selection === "all" ? body.selection : undefined
  const run: ValidationRun = { runId: randomUUID(), tenantId: tenant, platform, commit: pack.catalog.commit, reference: pack.catalog.reference, validatedAt: new Date().toISOString(), validationVersion: 1, ...(selection && { selection }), results }
  // Re-checking a single policy is not kept as a separate history entry.
  const saved = body.save !== false && saveValidations(tenant, [run, ...readValidations(tenant)], run.runId)
  return { ...run, saved }
}

export async function handleOib(body: RecordJson): Promise<unknown> {
  switch (body.action) {
    case "oib-source":
      return resolveMain()
    case "oib-versions":
      return oibVersions(body.retry === true)
    case "oib-downloads":
      return { downloads: oibDownloads() }
    case "oib-load":
      return (await loadPack(platformOf(body.platform), body.commit, body.tag)).catalog
    case "oib-compare":
      return compare(body)
    case "oib-deploy":
      return deploy(body, "deploy")
    case "oib-fix":
      return deploy(body, "fix")
    case "oib-undo":
      return undo(body)
    case "oib-backup-options":
      return backupOptions(body)
    case "oib-runs":
      return { runs: listRuns(body.tenantId) }
    case "oib-progress": {
      const tenant = tenantOf(body.tenantId)
      return progress.get(body.scope === "validate" ? `${tenant}:validate` : tenant) ?? null
    }
    case "oib-validate":
      return validate(body)
    case "oib-validations":
      return { runs: readValidations(tenantOf(body.tenantId)) }
    case "oib-validation-delete": {
      const tenant = tenantOf(body.tenantId)
      saveValidations(tenant, readValidations(tenant).filter((run) => run.runId !== body.runId))
      return { runs: readValidations(tenant) }
    }
    default:
      throw new FrameworkError("Unknown OpenIntuneBaseline action.")
  }
}
