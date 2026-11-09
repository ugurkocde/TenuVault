import { afterEach, expect, it, vi } from "vitest"
import type { Tenant } from "../src/portal/contexts/TenantContext"
import { deserializeTenants, serializeTenants } from "../src/portal/lib/tenant-state"
import { changeTenantStorage, savedAzureStorage } from "../src/renderer/lib/storage"
import { backupListKey, backupListOf, refreshBackupList, resetBackupLists } from "../src/renderer/lib/backup-list"
import { planGuard } from "../src/main/api/plan-gates"

afterEach(() => { vi.unstubAllGlobals(); resetBackupLists() })

it("preserves the full Azure configuration through local storage and a restart, then permits Azure reads and single-item restore", async () => {
  const original = { id: 1, credentials: { tenantId: "11111111-1111-1111-1111-111111111111", clientSecret: "fixture" }, resources: { storageAccountName: "stcontoso", subscriptionId: "subscription", subscriptionName: "Contoso", resourceGroupName: "rg-backups", resourceGroupLocation: "westeurope", automationAccountName: "aa-backups" } } as Tenant
  const local = { ...original, ...changeTenantStorage(original, { kind: "local" }) }
  expect(local.previousAzureStorage).toEqual(original.resources)
  const restarted = deserializeTenants(serializeTenants([local]))[0]!
  const azure = savedAzureStorage(restarted)!
  const returned = { ...restarted, ...changeTenantStorage(restarted, azure) }
  expect(returned.resources).toEqual(original.resources)
  const guard = planGuard(async () => "community")
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ storageAccountName: "stcontoso", subscriptionId: "subscription", resourceGroupName: "rg-backups" })
    return Response.json({ backups: [{ id: "azure-backup", timestamp: "2026-11-09T02:00:00Z", status: "Success" }] })
  })
  vi.stubGlobal("fetch", fetchMock)
  await refreshBackupList(returned)
  expect(backupListOf(backupListKey(returned)).backups).toMatchObject([{ id: "azure-backup" }])
  expect(fetchMock).toHaveBeenCalledOnce()
  for (const path of ["/api/list-backups", "/api/get-backup"]) {
    expect(await guard(new Request(`http://tenuvault.internal${path}`, { method: "POST", body: JSON.stringify({ tenantId: original.credentials!.tenantId, ...returned.resources }) }))).toBeNull()
  }
  expect(await guard(new Request("http://tenuvault.internal/api/restore-backup", { method: "POST", body: JSON.stringify({ tenantId: original.credentials!.tenantId, ...returned.resources, restoreType: "selective", selectedPolicies: [{ id: "policy" }], mode: "copy" }) }))).toBeNull()
  expect((await guard(new Request("http://tenuvault.internal/api/backup/start", { method: "POST", body: JSON.stringify({ tenantId: original.credentials!.tenantId, ...returned.resources }) })))?.status).toBe(402)
})
