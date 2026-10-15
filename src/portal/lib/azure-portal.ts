import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"

export interface AzureStoragePortalTarget {
  tenantId?: string | null
  subscriptionId?: string | null
  resourceGroupName?: string | null
  storageAccountName?: string | null
}

/**
 * Azure portal link to the storage account that holds a tenant's backups.
 *
 * Desktop backups run in the app, so there is no Automation job to view. The
 * useful destination is the storage browser of the account the backup was
 * written to. Returns null when the backup stayed on this device or when any
 * part of the storage location is unknown, so callers hide the link instead
 * of opening a broken URL.
 */
export function azureStoragePortalUrl(target: AzureStoragePortalTarget | null | undefined): string | null {
  const tenantId = target?.tenantId?.trim()
  const subscriptionId = target?.subscriptionId?.trim()
  const resourceGroupName = target?.resourceGroupName?.trim()
  const storageAccountName = target?.storageAccountName?.trim()
  if (!tenantId || !subscriptionId || !resourceGroupName || !storageAccountName) return null
  if (subscriptionId.toLowerCase() === "local" || resourceGroupName.toLowerCase() === "local") return null
  if (storageAccountName.toLowerCase().startsWith(LOCAL_STORAGE_PREFIX)) return null
  const segment = encodeURIComponent
  return `https://portal.azure.com/#@${segment(tenantId)}/resource/subscriptions/${segment(subscriptionId)}/resourceGroups/${segment(resourceGroupName)}/providers/Microsoft.Storage/storageAccounts/${segment(storageAccountName)}/storagebrowser`
}
