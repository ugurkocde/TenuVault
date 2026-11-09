import { BACKUP_OWNER_FILE } from "./constants"

/**
 * Which tenant a backup folder belongs to, decided once for every caller: retention, the backup
 * list, drift pair selection, restore and revert. The manifest's TenantId decides; a manifest
 * that names no tenant, or a folder without one, is placed by its ownership marker. Each caller
 * applies its own rule to the result (retention keeps what it cannot place, restore refuses it).
 */

/** One file of a backup folder as the caller read it. A read that must stop the caller throws instead. */
export type OwnershipFile = { kind: "missing" } | { kind: "found"; value: unknown } | { kind: "unreadable"; error: unknown }

export type BackupManifestRead = { kind: "missing" } | { kind: "found"; metadata: Record<string, any> } | { kind: "unreadable"; error: unknown }

export type BackupOwner =
  /** The manifest or marker names this tenant. */
  | { kind: "owned"; tenantId: string; source: "manifest" | "marker"; runId: string | null }
  /** The manifest or marker names another tenant. */
  | { kind: "other"; tenantId: string; source: "manifest" | "marker"; runId: string | null }
  /** Neither names a tenant: no marker, and a manifest that records none or is missing or could not be read. */
  | { kind: "untagged" }
  /** The marker exists but cannot be read or names no tenant, or the manifest records an invalid tenant and no marker places it. */
  | { kind: "unreadable"; error: unknown }

export interface BackupOwnership {
  manifest: BackupManifestRead
  owner: BackupOwner
}

export const DAMAGED_OWNER_MARKER = "This backup's ownership record is damaged, so TenuVault cannot tell which tenant it belongs to."
export const INVALID_MANIFEST_TENANT = "This backup's metadata records a tenant that is not valid, so TenuVault cannot tell which tenant it belongs to."

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value)
/** A recorded tenant: a string that is not blank. Any other string names a tenant, and only an equal one is this tenant. */
const validTenant = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

/**
 * Resolves a backup folder's ownership for `tenantId`. `read` returns `metadata.json` or the
 * ownership marker of the folder; the marker is only read when the manifest does not name a tenant.
 */
export async function resolveBackupOwnership(read: (file: "metadata.json" | typeof BACKUP_OWNER_FILE) => Promise<OwnershipFile>, tenantId: string): Promise<BackupOwnership> {
  const file = await read("metadata.json")
  // A manifest that records a tenant must record a valid one; one it cannot read is never "no tenant".
  const invalidTenant = file.kind === "found" && isRecord(file.value) && file.value.TenantId !== undefined && !validTenant(file.value.TenantId)
  const manifest: BackupManifestRead = file.kind === "found"
    ? !isRecord(file.value) ? { kind: "unreadable", error: new Error("metadata.json is not a JSON object") }
      : invalidTenant ? { kind: "unreadable", error: new Error(INVALID_MANIFEST_TENANT) }
      : { kind: "found", metadata: file.value }
    : file
  const named = (recorded: string, source: "manifest" | "marker", runId: unknown): BackupOwner => ({
    kind: recorded.toLowerCase() === tenantId.toLowerCase() ? "owned" : "other",
    tenantId: recorded,
    source,
    runId: typeof runId === "string" ? runId : null,
  })
  if (manifest.kind === "found" && validTenant(manifest.metadata.TenantId)) {
    return { manifest, owner: named(manifest.metadata.TenantId, "manifest", manifest.metadata.RunId) }
  }
  const marker = await read(BACKUP_OWNER_FILE)
  if (marker.kind === "missing") return { manifest, owner: invalidTenant ? { kind: "unreadable", error: new Error(INVALID_MANIFEST_TENANT) } : { kind: "untagged" } }
  if (marker.kind === "unreadable") return { manifest, owner: { kind: "unreadable", error: marker.error } }
  // Every marker names its tenant, so one that does not is damaged, never an untagged backup.
  if (!isRecord(marker.value) || !validTenant(marker.value.TenantId)) return { manifest, owner: { kind: "unreadable", error: new Error(DAMAGED_OWNER_MARKER) } }
  return { manifest, owner: named(marker.value.TenantId, "marker", marker.value.RunId) }
}
