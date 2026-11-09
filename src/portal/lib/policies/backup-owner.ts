import { belongsTo, type BackupMetadata } from "../../../shared/intune/drift"
import { BACKUP_OWNER_FILE, localStorageAccountName } from "../../../shared/constants"
import { isLegacyOtherTenantError } from "../../../shared/legacy-sealed"

export const OTHER_TENANT_BACKUP = "This backup belongs to another tenant."
const SEALED_BACKUP = "This backup was encrypted by an earlier TenuVault version and could not be opened for this tenant. It belongs to another tenant, or it needs the recovery key of the device that made it."

/**
 * Whether a backup's metadata allows `tenantId` to read it. Containers can be shared by several
 * tenants, so a backup recorded for another tenant is refused; older backups that record no
 * tenant, and backups without metadata, are allowed as before.
 */
export function ownedBy(metadata: unknown, tenantId: string): boolean {
  return !metadata || typeof metadata !== "object" || Array.isArray(metadata) || belongsTo(metadata as BackupMetadata, tenantId)
}

/** Why a backup without tenant evidence cannot change live policies; it can still be restored as an unassigned copy. */
export const UNTAGGED_BACKUP = "This backup does not record its tenant. Restore it as a copy instead."
const DAMAGED_MARKER = "This backup's ownership record is damaged, so TenuVault cannot tell which tenant it belongs to."

/**
 * `owned` is positive ownership: the backup's metadata or ownership marker names `tenantId`, or it
 * is in this tenant's own store on this device. Only an owned backup may change live policies
 * (replace restore, assignment restore, revert, recreate). A backup that records no tenant at
 * all can be viewed, compared, downloaded and restored as an unassigned copy.
 */
export type BackupOwnerRead =
  | { ok: true; metadata: Record<string, any> | null; owned: boolean }
  | { ok: false; status: number; error: string }

/** A legacy blob sealed for another tenant, or with a key this device lacks, fails to open after it was read. */
const sealedElsewhere = (error: unknown) => error instanceof Error && error.name === "FetchApplicationError"
const sealedError = (error: unknown) => isLegacyOtherTenantError(error) ? OTHER_TENANT_BACKUP : SEALED_BACKUP

/**
 * Reads a backup's metadata and checks that it belongs to `tenantId`. A backup whose metadata
 * records no tenant, or that has none (still running, stopped, or from an older version), is
 * placed by its ownership marker, as the backup list does; without a marker it is untagged: allowed,
 * but not owned. A marker that cannot be parsed or names no tenant is refused. Read failures are
 * errors, never a pass. `read` fetches a blob of the backup container by name. `storageAccountName`
 * is the account read from: this tenant's own store on this device holds only its backups.
 */
export async function readOwnedBackup(read: (name: string) => Promise<Response>, backupId: string, tenantId: string, storageAccountName?: string): Promise<BackupOwnerRead> {
  const ownStore = storageAccountName?.toLowerCase() === localStorageAccountName(tenantId)
  let response: Response
  try {
    response = await read(`${backupId}/metadata.json`)
  } catch (error) {
    if (sealedElsewhere(error)) return { ok: false, status: 403, error: sealedError(error) }
    throw error
  }
  if (response.ok) {
    let metadata: unknown
    try { metadata = await response.json() } catch { return { ok: false, status: 500, error: "The backup metadata could not be read." } }
    if (!ownedBy(metadata, tenantId)) return { ok: false, status: 403, error: OTHER_TENANT_BACKUP }
    const record = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, any> : null
    if (typeof record?.TenantId === "string") return { ok: true, metadata: record, owned: true }
    const owner = await readMarker(read, backupId, tenantId)
    return owner.ok ? { ok: true, metadata: record, owned: owner.owned || ownStore } : owner
  }
  if (response.status !== 404) return { ok: false, status: 500, error: "Failed to read backup metadata" }
  const owner = await readMarker(read, backupId, tenantId)
  return owner.ok ? { ...owner, owned: owner.owned || ownStore } : owner
}

/** Places a backup whose metadata names no tenant by its ownership marker; no marker leaves it untagged. */
async function readMarker(read: (name: string) => Promise<Response>, backupId: string, tenantId: string): Promise<BackupOwnerRead> {
  let marker: Response
  try {
    marker = await read(`${backupId}/${BACKUP_OWNER_FILE}`)
  } catch (error) {
    if (sealedElsewhere(error)) return { ok: false, status: 403, error: sealedError(error) }
    throw error
  }
  if (marker.status === 404) return { ok: true, metadata: null, owned: false }
  if (!marker.ok) return { ok: false, status: 500, error: "The backup's ownership record could not be read." }
  const owner = await marker.json().catch(() => null) as unknown
  // Every marker names its tenant, so one that does not is damaged, never an untagged backup.
  if (!owner || typeof owner !== "object" || Array.isArray(owner) || typeof (owner as { TenantId?: unknown }).TenantId !== "string") return { ok: false, status: 403, error: DAMAGED_MARKER }
  if (!ownedBy(owner, tenantId)) return { ok: false, status: 403, error: OTHER_TENANT_BACKUP }
  return { ok: true, metadata: null, owned: true }
}
