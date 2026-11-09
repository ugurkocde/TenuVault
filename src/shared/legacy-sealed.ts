/**
 * Backups in an Azure storage account are plain JSON: Azure encrypts them at rest and the
 * customer's Azure role assignments decide who reads them. Earlier versions encrypted every Azure
 * blob with the device key (a `TVAZ1` envelope). Those blobs stay readable where that key exists;
 * a read that no key on this device opens fails with this message and code.
 */
export const LEGACY_SEALED_MESSAGE = "This backup was encrypted by an earlier TenuVault version. Import the recovery key of the device that made it to open it."

/** Set as `code` on the read error, so routes can tell a legacy sealed blob from other failures. */
export const LEGACY_SEALED_CODE = "LegacySealedBackup"

/** A legacy sealed blob that a key on this device opens, but for another tenant signed in on this device. */
export const LEGACY_OTHER_TENANT_MESSAGE = "This backup belongs to another tenant."
export const LEGACY_OTHER_TENANT_CODE = "LegacySealedOtherTenant"

/** Whether `error` is a read of a legacy sealed blob that no key on this device opens for this tenant. */
export function isLegacySealedError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === LEGACY_SEALED_CODE
}

/** Whether `error` is a read of a legacy sealed blob that belongs to another tenant signed in on this device. */
export function isLegacyOtherTenantError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === LEGACY_OTHER_TENANT_CODE
}
