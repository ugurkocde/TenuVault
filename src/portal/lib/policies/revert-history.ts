import { isGuid } from "../../../shared/security"
import { BACKUP_OWNER_FILE } from "../../../shared/constants"

/**
 * The revert history that older versions kept for the whole container, keyed by policy ID only.
 * Tenants sharing a container wrote into the same file, so it is only read, never written.
 */
export const LEGACY_REVERT_HISTORY = "metadata/revert-history.json"

export type RevertHistory = { reverts: Record<string, Array<Record<string, any>>> }

/** The tenant's own revert history blob, or null when `tenantId` is not a GUID. */
export function revertHistoryPath(tenantId: unknown): string | null {
  return isGuid(tenantId) ? `metadata/${tenantId.toLowerCase()}/revert-history.json` : null
}

/** Reads a blob of the backup container by name. */
export type BlobRead = (name: string) => Promise<Response>

/**
 * The entries of the legacy shared history that belong to `tenantId`. Legacy entries record no
 * tenant, so each is attributed by the backup it names (fromBackup, or toBackup): only a backup
 * whose metadata or ownership marker names this tenant counts. Entries whose backup names no
 * tenant, is gone, or cannot be opened are left out, since they may be another tenant's. A read
 * failure throws, so a caller never mistakes it for an empty history.
 */
export async function readLegacyRevertHistory(read: BlobRead, tenantId: string): Promise<RevertHistory> {
  const response = await read(LEGACY_REVERT_HISTORY)
  if (response.status === 404) return { reverts: {} }
  if (!response.ok) throw new Error(`Failed to read the legacy revert history (${response.status})`)
  const legacy = await response.json().catch(() => null) as Partial<RevertHistory> | null
  const reverts = legacy?.reverts && typeof legacy.reverts === "object" ? legacy.reverts : {}

  const owners = new Map<string, Promise<boolean>>()
  const owned = (backup: string) => {
    if (!owners.has(backup)) owners.set(backup, backupOwnedBy(read, backup, tenantId))
    return owners.get(backup)!
  }
  const result: RevertHistory = { reverts: {} }
  for (const [policyId, entries] of Object.entries(reverts)) {
    if (!Array.isArray(entries)) continue
    const kept: Array<Record<string, any>> = []
    for (const entry of entries) {
      const backup = backupOf(entry?.fromBackup) ?? backupOf(entry?.toBackup)
      if (backup && await owned(backup)) kept.push(entry)
    }
    if (kept.length > 0) result.reverts[policyId] = kept
  }
  return result
}

/** The backup folder an entry names: a folder name, or the first segment of a policy path. */
function backupOf(value: unknown): string | null {
  if (typeof value !== "string") return null
  const folder = value.split("/")[0] ?? ""
  return /^[A-Za-z0-9_-]+$/.test(folder) ? folder : null
}

/** Whether the backup's metadata, or else its ownership marker, positively names `tenantId`. */
async function backupOwnedBy(read: BlobRead, backup: string, tenantId: string): Promise<boolean> {
  for (const file of ["metadata.json", BACKUP_OWNER_FILE]) {
    let response: Response
    try {
      response = await read(`${backup}/${file}`)
    } catch (error) {
      // Sealed for another tenant or key: not this tenant's to claim.
      if (error instanceof Error && error.name === "FetchApplicationError") return false
      throw error
    }
    if (response.status === 404) continue
    if (!response.ok) throw new Error(`Failed to read ${backup}/${file} (${response.status})`)
    // As in readOwnedBackup, a marker that failed authentication places nothing.
    if (file === BACKUP_OWNER_FILE && response.headers.get("x-tenuvault-authenticated") === "false") return false
    const record = await response.json().catch(() => null)
    if (typeof record?.TenantId === "string") return record.TenantId.toLowerCase() === tenantId.toLowerCase()
  }
  return false
}
