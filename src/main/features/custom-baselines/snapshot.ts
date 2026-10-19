import { normalizeBackupStatus } from "../../../portal/lib/backup-health"
import type { Item } from "../../../shared/intune/registry"
import type { FeatureDeps } from "../deps"
import { FeatureError } from "../route"
import { FOLDER } from "./model"

/**
 * Reads the Settings Catalog policies of one backup through the app's own backup routes
 * (list-backups, list-backup-contents, restore-preview), the same way the hygiene explorer
 * reads backups, so local and Azure storage behave the same. Nothing is read from the tenant.
 */

export interface SnapshotOption {
  id: string
  timestamp: string
  status: string
  /** Complete: the backup succeeded and Settings Catalog policies were in scope and read. */
  usable: boolean
  reason: string | null
}

export interface SnapshotPolicies {
  backupId: string
  collectedAt: string
  items: Array<{ name: string; snapshot: Item }>
}

const CHUNK = 500

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const detail = typeof body.details === "string" ? body.details : typeof body.error === "string" ? body.error : `status ${response.status}`
    throw new FeatureError(`${what} is unavailable: ${detail}`, 502)
  }
  return body
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])

type BackupEntry = { id?: unknown; timestamp?: unknown; status?: unknown }

async function listBackups(deps: FeatureDeps, tenantId: string): Promise<Array<BackupEntry & { id: string }>> {
  const listing = await json(await deps.api("/api/list-backups", tenantId), "The backup list")
  const backups = (Array.isArray(listing.backups) ? listing.backups : []) as BackupEntry[]
  return backups.filter((backup): backup is BackupEntry & { id: string } => typeof backup.id === "string")
}

/** Complete backups count with any status the backup health view treats as success, such as "Succeeded". */
function snapshotOption(backup: BackupEntry & { id: string }): SnapshotOption {
  const status = typeof backup.status === "string" ? backup.status : "unknown"
  const usable = normalizeBackupStatus(backup) === "success"
  return { id: backup.id, timestamp: typeof backup.timestamp === "string" ? backup.timestamp : "", status, usable, reason: usable ? null : "Only complete backups (status Success) can become a company baseline." }
}

/** Backups of the tenant, newest first as the route lists them, with whether each can be used. */
export async function listSnapshots(deps: FeatureDeps, tenantId: string): Promise<SnapshotOption[]> {
  return (await listBackups(deps, tenantId)).slice(0, 100).map(snapshotOption)
}

/**
 * The Settings Catalog policies of a complete backup. Refuses a backup that did not succeed,
 * that left Settings Catalog policies out of scope, skipped or failed them, or whose files
 * could not all be read: a company baseline never silently misses policies.
 */
export async function readSnapshot(deps: FeatureDeps, tenantId: string, backupId: string): Promise<SnapshotPolicies> {
  // Looked up in the full list, not only the newest 100 the picker shows.
  const found = (await listBackups(deps, tenantId)).find((backup) => backup.id === backupId)
  const chosen = found ? snapshotOption(found) : null
  if (!chosen) throw new FeatureError("That backup was not found for this tenant.", 404)
  if (!chosen.usable) throw new FeatureError(chosen.reason ?? "This backup is not complete.", 409)
  const contents = await json(await deps.api("/api/list-backup-contents", tenantId, { backupId }), "The backup contents")
  const content = (contents.content ?? {}) as { groups?: Array<{ folder?: string; policies?: Array<{ path?: string }> }>; metadata?: Record<string, unknown> }
  const metadata = content.metadata ?? {}
  const missing = [strings((metadata.Scope as Record<string, unknown> | undefined)?.Excluded), strings(metadata.SkippedTypes), strings(metadata.FailedTypes)].some((list) => list.includes(FOLDER))
  if (missing) throw new FeatureError("This backup did not collect Settings Catalog policies completely (excluded, skipped or failed). Choose another backup.", 409)
  const paths = (content.groups ?? []).filter((group) => group.folder === FOLDER).flatMap((group) => (group.policies ?? []).map((policy) => policy.path).filter((path): path is string => typeof path === "string"))
  if (!paths.length) throw new FeatureError("This backup holds no Settings Catalog policies.", 404)
  const items: SnapshotPolicies["items"] = []
  for (let start = 0; start < paths.length; start += CHUNK) {
    const preview = await json(await deps.api("/api/restore-preview", tenantId, { backupId, paths: paths.slice(start, start + CHUNK) }), "Reading the backup")
    for (const entry of (Array.isArray(preview.items) ? preview.items : []) as Array<{ folder?: string; snapshot?: Item; error?: string }>) {
      if (entry.folder !== FOLDER) continue
      const name = entry.snapshot?.name
      if (entry.error || !entry.snapshot || typeof name !== "string" || !name.trim()) throw new FeatureError("A Settings Catalog policy in this backup could not be read. Choose another backup.", 502)
      items.push({ name: name.trim(), snapshot: entry.snapshot })
    }
  }
  if (items.length !== paths.length) throw new FeatureError("Not every Settings Catalog policy of this backup could be read. Choose another backup.", 502)
  return { backupId, collectedAt: chosen.timestamp, items }
}
