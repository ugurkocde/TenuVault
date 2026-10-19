import { belongsTo, type BackupMetadata } from "../../../shared/intune/drift"

export const OTHER_TENANT_BACKUP = "This backup belongs to another tenant."

/**
 * Whether a backup's metadata allows `tenantId` to read it. Containers can be shared by several
 * tenants, so a backup recorded for another tenant is refused; older backups that record no
 * tenant, and backups without metadata, are allowed as before.
 */
export function ownedBy(metadata: unknown, tenantId: string): boolean {
  return !metadata || typeof metadata !== "object" || Array.isArray(metadata) || belongsTo(metadata as BackupMetadata, tenantId)
}
