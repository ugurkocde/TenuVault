import { belongsTo, type BackupMetadata } from "../../../shared/intune/drift"
import { BACKUP_OWNER_FILE } from "../../../shared/constants"
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

export type BackupOwnerRead =
  | { ok: true; metadata: Record<string, any> | null }
  | { ok: false; status: number; error: string }

/** A legacy blob sealed for another tenant, or with a key this device lacks, fails to open after it was read. */
const sealedElsewhere = (error: unknown) => error instanceof Error && error.name === "FetchApplicationError"
const sealedError = (error: unknown) => isLegacyOtherTenantError(error) ? OTHER_TENANT_BACKUP : SEALED_BACKUP

/**
 * Reads a backup's metadata and checks that it belongs to `tenantId`. A backup whose metadata
 * records no tenant, or that has none (still running, stopped, or from an older version), is
 * placed by its ownership marker, as the backup list does; without a marker it is allowed. Read
 * failures are errors, never a pass. `read` fetches a blob of the backup container by name.
 */
export async function readOwnedBackup(read: (name: string) => Promise<Response>, backupId: string, tenantId: string): Promise<BackupOwnerRead> {
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
    const owned = { ok: true as const, metadata: record }
    if (typeof record?.TenantId === "string") return owned
    const owner = await readMarker(read, backupId, tenantId)
    return owner.ok ? owned : owner
  }
  if (response.status !== 404) return { ok: false, status: 500, error: "Failed to read backup metadata" }
  return readMarker(read, backupId, tenantId)
}

/** Places a backup whose metadata names no tenant by its ownership marker; no marker allows it. */
async function readMarker(read: (name: string) => Promise<Response>, backupId: string, tenantId: string): Promise<BackupOwnerRead> {
  let marker: Response
  try {
    marker = await read(`${backupId}/${BACKUP_OWNER_FILE}`)
  } catch (error) {
    if (sealedElsewhere(error)) return { ok: false, status: 403, error: sealedError(error) }
    throw error
  }
  if (marker.status === 404) return { ok: true, metadata: null }
  if (!marker.ok) return { ok: false, status: 500, error: "The backup's ownership record could not be read." }
  const owner = await marker.json().catch(() => null)
  if (!ownedBy(owner, tenantId)) return { ok: false, status: 403, error: OTHER_TENANT_BACKUP }
  return { ok: true, metadata: null }
}
