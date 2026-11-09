import type { Tenant } from "~/contexts/TenantContext"
import { DELEGATED_CLIENT_SECRET, LOCAL_STORAGE_PREFIX, localStorageAccountName } from "../../shared/constants"

/** Where a tenant's backups are stored. */
export type StorageChoice =
  | { kind: "local" }
  | { kind: "azure"; storageAccountName: string; subscriptionId: string; resourceGroupName: string; location: string }

export interface AzureStorageAccount {
  name: string
  subscriptionId: string
  resourceGroup: string
  location: string
}

/**
 * Tenant resource fields for a storage choice. Local storage uses placeholder
 * subscription and resource group values because the shared routes require them
 * but never use them for local accounts.
 */
export function storageResources(tenantId: string, choice: StorageChoice) {
  return choice.kind === "local"
    ? {
        storageAccountName: localStorageAccountName(tenantId),
        subscriptionId: "local",
        resourceGroupName: "local",
        resourceGroupLocation: "",
      }
    : {
        storageAccountName: choice.storageAccountName,
        subscriptionId: choice.subscriptionId,
        resourceGroupName: choice.resourceGroupName,
        resourceGroupLocation: choice.location,
      }
}

export async function listStorageAccounts(tenantId: string, clientId: string): Promise<AzureStorageAccount[]> {
  const response = await fetch("/api/list-azure-resources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, appId: clientId, clientSecret: DELEGATED_CLIENT_SECRET }),
  })
  const data = (await response.json()) as { storageAccounts?: AzureStorageAccount[]; error?: string }
  if (!response.ok) throw new Error(data.error ?? "Could not list your Azure storage accounts.")
  return (data.storageAccounts ?? []).sort((a, b) => a.name.localeCompare(b.name))
}

export function savedAzureStorage(tenant: Tenant): Extract<StorageChoice, { kind: "azure" }> | undefined {
  const resources = tenant.resources?.storageAccountName && !tenant.resources.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)
    ? tenant.resources : tenant.previousAzureStorage
  if (!resources) return undefined
  return { kind: "azure", storageAccountName: resources.storageAccountName, subscriptionId: resources.subscriptionId, resourceGroupName: resources.resourceGroupName, location: resources.resourceGroupLocation ?? "" }
}

export function changeTenantStorage(tenant: Tenant, choice: StorageChoice): Partial<Tenant> {
  const previous = tenant.resources?.storageAccountName && !tenant.resources.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)
    ? tenant.resources : tenant.previousAzureStorage
  const returning = choice.kind === "azure" && previous?.storageAccountName === choice.storageAccountName && previous.subscriptionId === choice.subscriptionId && previous.resourceGroupName === choice.resourceGroupName
  return {
    previousAzureStorage: previous ? { ...previous } : undefined,
    resources: returning ? { ...previous } : { ...tenant.resources, ...storageResources(tenant.credentials!.tenantId, choice), subscriptionName: tenant.resources?.subscriptionName ?? "", automationAccountName: tenant.resources?.automationAccountName ?? "" },
  }
}

export const LOCAL_SWITCH_CONFIRMATION = {
  title: "Save new backups on this computer?",
  description: "Backups will be saved on this computer from now on. Your existing Azure backups are kept and can be reached by switching storage back to Azure. Azure backups resume with Pro. Your saved schedule is kept.",
  confirmLabel: "Switch to local backups",
}
