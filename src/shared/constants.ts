/**
 * Placeholder written into the `clientSecret` field of desktop tenant profiles.
 *
 * The shared API route code expects `tenantId`, `appId` and `clientSecret` and
 * requests tokens with the client credentials grant. In the desktop app there is
 * no secret: the main process intercepts those token requests and answers them
 * with a delegated token for the signed-in admin (see main/api/fetch-bridge.ts).
 */
export const DELEGATED_CLIENT_SECRET = "tenuvault-desktop-delegated-auth"

/** Origin the shared route code uses when it calls its own API (for example audit logging). */
export const INTERNAL_API_ORIGIN = "http://tenuvault.internal"

/** Azure resources the shared route code requests tokens for. */
export const RESOURCE_SCOPES = {
  graph: "https://graph.microsoft.com/.default",
  management: "https://management.azure.com/.default",
  storage: "https://storage.azure.com/.default",
} as const

export const DOCS_URL = "https://docs.tenuvault.com/getting-started/app-registration/"

export const DOCS_HOME_URL = "https://docs.tenuvault.com/"

export const TERMS_URL = "https://tenuvault.com/terms"

/** Email support is part of the paid plans; Community users open a GitHub issue instead. */
export const SUPPORT_EMAIL = "support@ugurlabs.com"

export const GITHUB_ISSUES_URL = "https://github.com/ugurkocde/TenuVault/issues/new"

/** Prefix of the storage account name used for tenants whose backups stay on this device. */
export const LOCAL_STORAGE_PREFIX = "tvlocal-"

export function localStorageAccountName(tenantId: string): string {
  return `${LOCAL_STORAGE_PREFIX}${tenantId.toLowerCase()}`
}

/** Blob container that holds backups and that all backup routes read. */
export const BACKUP_CONTAINER = "intune-backups"

/**
 * Largest total size of the files in one backup archive, in bytes. Backup
 * downloads are built in memory, and imports refuse larger archives, so both
 * paths share this bound. Defined here so every caller uses the same value.
 */
export const MAX_BACKUP_ARCHIVE_BYTES = 32 * 1024 * 1024

/** Most files in one backup archive, matching the import bound. */
export const MAX_BACKUP_ARCHIVE_FILES = 5000

/** Encrypted ownership evidence for abandoned folders, excluded from exported archives. */
export const BACKUP_OWNER_FILE = ".tenuvault-owner.json"
