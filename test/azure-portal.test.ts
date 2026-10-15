import { describe, expect, it, vi } from "vitest"
import { azureStoragePortalUrl } from "../src/portal/lib/azure-portal"
import { trackBackup } from "../src/renderer/lib/backups"
import type { Tenant } from "../src/portal/contexts/TenantContext"

const azure = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  subscriptionId: "d3d5f58c-d37c-4ba5-9ac3-f92ea0bb531a",
  resourceGroupName: "Intune_LAW",
  storageAccountName: "tvdesktope2e",
}

describe("View in Azure portal link", () => {
  it("opens the backup storage account in the storage browser", () => {
    expect(azureStoragePortalUrl(azure)).toBe(
      "https://portal.azure.com/#@11111111-1111-1111-1111-111111111111/resource/subscriptions/d3d5f58c-d37c-4ba5-9ac3-f92ea0bb531a/resourceGroups/Intune_LAW/providers/Microsoft.Storage/storageAccounts/tvdesktope2e/storagebrowser",
    )
  })

  it("never builds an Automation job link or an empty segment", () => {
    const url = azureStoragePortalUrl(azure)
    expect(url).not.toContain("automationAccounts")
    expect(url).not.toContain("//resource")
    expect(azureStoragePortalUrl({ ...azure, storageAccountName: "" })).toBeNull()
    expect(azureStoragePortalUrl({ ...azure, subscriptionId: "" })).toBeNull()
    expect(azureStoragePortalUrl({ ...azure, resourceGroupName: "  " })).toBeNull()
    expect(azureStoragePortalUrl({ ...azure, tenantId: "" })).toBeNull()
    expect(azureStoragePortalUrl({})).toBeNull()
  })

  it("has no Azure link for backups kept on this device", () => {
    expect(azureStoragePortalUrl({ ...azure, subscriptionId: "local", resourceGroupName: "local", storageAccountName: "tvlocal-11111111-1111-1111-1111-111111111111" })).toBeNull()
    expect(azureStoragePortalUrl({ ...azure, storageAccountName: "TVLOCAL-11111111-1111-1111-1111-111111111111" })).toBeNull()
  })

  it("links to a real Azure resource group that happens to be named local", () => {
    expect(azureStoragePortalUrl({ ...azure, resourceGroupName: "local" })).toContain("/resourceGroups/local/providers/Microsoft.Storage/storageAccounts/tvdesktope2e/storagebrowser")
  })

  it("encodes resource names that need it", () => {
    expect(azureStoragePortalUrl({ ...azure, resourceGroupName: "rg backups #1" })).toContain("/resourceGroups/rg%20backups%20%231/")
  })

  it("keeps the tenant storage location on jobs tracked in the floating panel", () => {
    const addJob = vi.fn()
    const tenant = {
      name: "Ugur Koc Lab 123",
      credentials: { tenantId: azure.tenantId, appId: "app", clientSecret: "" },
      resources: { subscriptionId: azure.subscriptionId, subscriptionName: "", resourceGroupName: azure.resourceGroupName, storageAccountName: azure.storageAccountName, automationAccountName: "" },
    } as unknown as Tenant
    trackBackup(tenant, "desktop-job", addJob)
    expect(addJob).toHaveBeenCalledWith(expect.objectContaining({
      resources: expect.objectContaining({
        subscriptionId: azure.subscriptionId,
        resourceGroupName: azure.resourceGroupName,
        storageAccountName: azure.storageAccountName,
      }),
    }))
  })
})
