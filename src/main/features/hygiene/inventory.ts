import { mapLimit } from "../../../shared/map-limit"
import { INTUNE_TYPES, itemName, typeForFolder, type Item } from "../../../shared/intune/registry"
import { normalizeBackupStatus } from "../../../portal/lib/backup-health"
import { isGuid } from "../../../shared/security"
import type { FeatureDeps } from "../deps"
import { FeatureError } from "../route"
import type { GroupState, InventoryItem } from "./rules"

/** Why a type is missing from the collection. */
export interface NotCollected {
  folder: string
  label: string
  reason: "excluded" | "skipped" | "failed" | "unreadable"
}

export interface CollectedInventory {
  backupId: string
  /** When the backup was taken; the findings describe the tenant at this time. */
  collectedAt: string
  /** "complete" when every type in scope and every item was read; otherwise "partial". */
  completeness: "complete" | "partial"
  partialReason: string | null
  items: InventoryItem[]
  covered: string[]
  notCollected: NotCollected[]
  unreadableItems: number
}

interface BackupSummary {
  id: string
  timestamp: string
  status: string
}

const PREVIEW_CHUNK = 2000
const GROUP_LIMIT = 300
/** Group existence reads running at once. */
const GROUP_CONCURRENCY = 6

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const detail = typeof body.details === "string" ? body.details : typeof body.error === "string" ? body.error : `status ${response.status}`
    throw new FeatureError(`${what} is unavailable: ${detail}`, 502)
  }
  return body
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/**
 * Reads the inventory from the newest complete backup (status Success or an equivalent such as
 * Succeeded), or the newest backup that completed with warnings when there is no complete one;
 * that inventory is marked partial. Everything goes through the app's own backup routes, so local and Azure storage
 * behave the same and the collection date is the backup's.
 *
 * `backupId` picks a specific backup instead. Types left out of the backup scope, skipped for
 * missing permissions or failed are listed as not collected.
 */
export async function collectFromBackup(deps: FeatureDeps, tenantId: string, backupId: string | null): Promise<CollectedInventory> {
  const listing = await json(await deps.api("/api/list-backups", tenantId), "The backup list")
  const backups = (Array.isArray(listing.backups) ? listing.backups : []) as BackupSummary[]
  const chosen = backupId
    ? backups.find((backup) => backup.id === backupId)
    : backups.find((backup) => normalizeBackupStatus(backup) === "success") ?? backups.find((backup) => normalizeBackupStatus(backup) === "partial")
  if (!chosen) {
    throw new FeatureError(backupId ? "That backup was not found for this tenant." : "No complete backup is available. Run a backup first; hygiene findings are built from the latest complete backup.", 404)
  }

  const contents = await json(await deps.api("/api/list-backup-contents", tenantId, { backupId: chosen.id }), "The backup contents")
  const content = (contents.content ?? {}) as { groups?: Array<{ folder?: string; policies?: Array<{ path?: string }> }>; metadata?: Record<string, unknown> }
  const metadata = content.metadata ?? {}
  const excluded = new Set(strings((metadata.Scope as Record<string, unknown> | undefined)?.Excluded))
  const skipped = new Set(strings(metadata.SkippedTypes))
  const failed = new Set(strings(metadata.FailedTypes))
  const notCollected: NotCollected[] = []
  const covered: string[] = []
  for (const type of INTUNE_TYPES) {
    const reason = excluded.has(type.folder) ? "excluded" : skipped.has(type.folder) ? "skipped" : failed.has(type.folder) ? "failed" : null
    if (reason) notCollected.push({ folder: type.folder, label: type.label, reason })
    else covered.push(type.folder)
  }

  const paths = (content.groups ?? []).flatMap((group) => (group.policies ?? []).map((policy) => policy.path).filter((path): path is string => typeof path === "string"))
  const items: InventoryItem[] = []
  const unreadableFolders = new Set<string>()
  let unreadable = 0
  for (let start = 0; start < paths.length; start += PREVIEW_CHUNK) {
    const preview = await json(await deps.api("/api/restore-preview", tenantId, { backupId: chosen.id, paths: paths.slice(start, start + PREVIEW_CHUNK) }), "Reading the backup")
    for (const entry of (Array.isArray(preview.items) ? preview.items : []) as Array<{ folder?: string; snapshot?: Item; error?: string }>) {
      const type = typeof entry.folder === "string" ? typeForFolder(entry.folder) : undefined
      if (!type) continue
      const snapshot = entry.snapshot
      if (!snapshot || typeof snapshot.id !== "string" || entry.error) {
        unreadable++
        unreadableFolders.add(type.folder)
        continue
      }
      items.push({ folder: type.folder, id: snapshot.id, name: itemName(type, snapshot), snapshot })
    }
  }
  // A type with an unreadable item is only partly known; it is not inspected as if complete.
  for (const folder of unreadableFolders) {
    const index = covered.indexOf(folder)
    if (index >= 0) covered.splice(index, 1)
    notCollected.push({ folder, label: typeForFolder(folder)?.label ?? folder, reason: "unreadable" })
  }

  const state = normalizeBackupStatus(chosen)
  const reasons = [
    state === "cancelled" ? "The backup was cancelled before it finished; some objects may be missing." : state !== "success" ? "The backup completed with warnings; some objects may be missing." : "",
    failed.size ? `${failed.size} types could not be read.` : "",
    skipped.size ? `${skipped.size} types were skipped for missing permissions.` : "",
    unreadable ? `${unreadable} backup files could not be read.` : "",
  ].filter(Boolean)
  return {
    backupId: chosen.id,
    collectedAt: chosen.timestamp,
    completeness: reasons.length ? "partial" : "complete",
    partialReason: reasons.length ? reasons.join(" ") : null,
    items,
    covered,
    notCollected,
    unreadableItems: unreadable,
  }
}

export interface GroupResolution {
  groups: Map<string, GroupState>
  state: "resolved" | "unavailable" | "partial" | "none"
  reason?: string
}

/**
 * Checks whether referenced groups exist with GET groups/{id}?$select=id (read only).
 * 200 means it exists, 404 that it does not. The TenuVault app only requests
 * Group.Read.All when the setup script ran with -IncludeGroupRead, so a 401 or 403 stops
 * the checks and leaves every group unknown; any other failure leaves that group unknown.
 * Unknown is never reported as missing or as fine.
 */
export async function resolveGroups(deps: FeatureDeps, tenantId: string, items: InventoryItem[]): Promise<GroupResolution> {
  const ids = new Set<string>()
  for (const item of items) {
    const list = Array.isArray(item.snapshot.assignments) ? item.snapshot.assignments : []
    for (const assignment of list) {
      const target = (assignment as Item | null)?.target as Item | undefined
      const id = target?.groupId
      if (isGuid(id)) ids.add(id.toLowerCase())
    }
  }
  const groups = new Map<string, GroupState>()
  if (!ids.size) return { groups, state: "none" }
  const unavailable = "Group existence cannot be read with this app's permissions (Group.Read.All is not granted), so group references are unknown. To let this check run, add Group.Read.All to the app registration and grant admin consent (run New-TenuVaultDesktopApp.ps1 with -IncludeGroupRead), then sign in again and rescan."
  let graph: Awaited<ReturnType<FeatureDeps["graph"]>>
  try {
    graph = await deps.graph(tenantId)
  } catch {
    return { groups, state: "unavailable", reason: "Microsoft Graph is unavailable (sign in to this tenant), so group references are unknown." }
  }
  // A 401 or 403 stops the checks early: no new reads start and every group stays unknown.
  let denied = false
  const limited = [...ids].slice(0, GROUP_LIMIT)
  const statuses = await mapLimit(limited, GROUP_CONCURRENCY, async (id): Promise<number | null> => {
    if (denied) return null
    let status: number
    try {
      status = (await graph("GET", `groups/${encodeURIComponent(id)}?$select=id`)).status
    } catch {
      status = 0
    }
    if (status === 401 || status === 403) denied = true
    return status
  })
  if (denied) return { groups: new Map(), state: "unavailable", reason: unavailable }
  let checked = 0
  let unknown = 0
  for (const [index, status] of statuses.entries()) {
    if (status === null) continue
    checked++
    const id = limited[index]!
    if (status >= 200 && status < 300) groups.set(id, "exists")
    else if (status === 404) groups.set(id, "missing")
    else unknown++
  }
  const partial = unknown > 0 || ids.size > checked
  return { groups, state: partial ? "partial" : "resolved", ...(partial ? { reason: `${ids.size - groups.size} referenced groups could not be checked and are unknown.` } : {}) }
}
