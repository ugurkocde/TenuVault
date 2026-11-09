import { localStorageAccountName } from "../../../shared/constants"
import { DAMAGED_OWNER_MARKER, INVALID_MANIFEST_TENANT, resolveBackupOwnership, type OwnershipFile } from "../../../shared/backup-ownership"
import { isLegacyOtherTenantError } from "../../../shared/legacy-sealed"

export const OTHER_TENANT_BACKUP = "This backup belongs to another tenant."
const SEALED_BACKUP = "This backup was encrypted by an earlier TenuVault version and could not be opened for this tenant. It belongs to another tenant, or it needs the recovery key of the device that made it."

/** Why a backup without tenant evidence cannot change live policies; it can still be restored as an unassigned copy. */
export const UNTAGGED_BACKUP = "This backup does not record its tenant. Restore it as a copy instead."

/**
 * `owned` is positive ownership: the backup's metadata or ownership marker names `tenantId`, or it
 * is in this tenant's own store on this device. Only an owned backup may change live policies
 * (replace restore, assignment restore, revert, recreate). A backup that records no tenant at
 * all can be viewed, compared, downloaded and restored as an unassigned copy.
 */
export type BackupOwnerRead =
  | { ok: true; metadata: Record<string, any> | null; owned: boolean }
  | { ok: false; status: number; error: string }

/** A read the route answers with this status and message instead of the resolver's outcome. */
class RefusedRead extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** A legacy blob sealed for another tenant, or with a key this device lacks, fails to open after it was read. */
const sealedElsewhere = (error: unknown) => error instanceof Error && error.name === "FetchApplicationError"
const sealedError = (error: unknown) => isLegacyOtherTenantError(error) ? OTHER_TENANT_BACKUP : SEALED_BACKUP

/** Why a backup whose metadata or marker could not be read is refused. */
function refusal(error: unknown, fallback: string): { ok: false; status: number; error: string } {
  if (sealedElsewhere(error)) return { ok: false, status: 403, error: sealedError(error) }
  if (error instanceof RefusedRead) return { ok: false, status: error.status, error: error.message }
  if (error instanceof Error && (error.message === DAMAGED_OWNER_MARKER || error.message === INVALID_MANIFEST_TENANT)) return { ok: false, status: 403, error: error.message }
  return { ok: false, status: 500, error: fallback }
}

/**
 * Reads a backup's ownership with the shared resolver (shared/backup-ownership.ts) and checks that
 * it belongs to `tenantId`. Another tenant's backup is refused, and so is one whose metadata or
 * marker cannot be read; one that records no tenant is allowed, but not owned. `read` fetches a
 * blob of the backup container by name. `storageAccountName` is the account read from: this
 * tenant's own store on this device holds only its backups.
 */
export async function readOwnedBackup(read: (name: string) => Promise<Response>, backupId: string, tenantId: string, storageAccountName?: string): Promise<BackupOwnerRead> {
  const ownStore = storageAccountName?.toLowerCase() === localStorageAccountName(tenantId)
  const readFile = async (file: string): Promise<OwnershipFile> => {
    let response: Response
    try {
      response = await read(`${backupId}/${file}`)
    } catch (error) {
      if (sealedElsewhere(error)) return { kind: "unreadable", error }
      throw error
    }
    if (response.status === 404) return { kind: "missing" }
    const manifest = file === "metadata.json"
    if (!response.ok) return { kind: "unreadable", error: new RefusedRead(500, manifest ? "Failed to read backup metadata" : "The backup's ownership record could not be read.") }
    try { return { kind: "found", value: await response.json() } }
    catch { return { kind: "unreadable", error: manifest ? new RefusedRead(500, "The backup metadata could not be read.") : new Error(DAMAGED_OWNER_MARKER) } }
  }
  const { manifest, owner } = await resolveBackupOwnership(readFile, tenantId)
  if (manifest.kind === "unreadable") return refusal(manifest.error, "The backup metadata could not be read.")
  if (owner.kind === "unreadable") return refusal(owner.error, "The backup's ownership record could not be read.")
  if (owner.kind === "other") return { ok: false, status: 403, error: OTHER_TENANT_BACKUP }
  const metadata = manifest.kind === "found" ? manifest.metadata : null
  return { ok: true, metadata, owned: owner.kind === "owned" || ownStore }
}
