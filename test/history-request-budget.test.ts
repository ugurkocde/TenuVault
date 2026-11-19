import { snapshotHash } from "../src/portal/lib/policies/backup-manifest"
import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { POST as history } from "../src/portal/app/api/list-backups/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"
import { BACKUP_CONTAINER, BACKUP_OWNER_FILE } from "../src/shared/constants"
import { backupBlobName, LARGE_BACKUP_CONTAINER } from "../src/shared/backup-storage"

const tenant = "11111111-1111-1111-1111-111111111111", account = `tvlocal-${tenant}`
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

for (const azure of [false, true]) for (const legacy of [false, true]) {
  it(`bounds history requests for 500 ${legacy ? 'legacy' : 'ordinary'} folders and running, crashed and finished large backups (${azure ? 'Azure emulator' : 'local store'})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tv-history-budget-")); roots.push(root)
    const store = new LocalBlobStore(root, [Buffer.alloc(32, 5)])
    for (const container of [BACKUP_CONTAINER, LARGE_BACKUP_CONTAINER]) await store.createContainer(account, container)
    const write = (container: string, name: string, value: unknown) => store.put(account, container, name, Buffer.from(JSON.stringify(value)), "application/json")
    for (let at = 0; at < 500; at++) {
      const date = new Date(Date.UTC(2020, 0, 1 + at)).toISOString().slice(0, 10)
      const folder = legacy ? `${date}_00-00-00` : `backup-${date}-000000`
      await write(BACKUP_CONTAINER, `${folder}/metadata.json`, { Status: "Success", ...(legacy ? {} : { TenantId: tenant }) })
      await write(BACKUP_CONTAINER, `${folder}/${legacy ? 'DeviceCompliancePolicies' : 'CompliancePolicies'}/one.json`, { id: "one" })
    }
    const requests: URL[] = [], inventories: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = new URL(String(input)); requests.push(new URL(url))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'storage' })
      if (url.searchParams.get('comp') === 'list') {
        if (url.pathname === `/${LARGE_BACKUP_CONTAINER}`) expect(url.searchParams.get('prefix')).toBe('backup-large-')
        else expect(url.searchParams.get('prefix') ?? '').not.toContain('large')
      }
      url.hostname = `${account}.blob.core.windows.net`
      const response = await handleLocalBlobRequest(store, new Request(url, init))
      if (url.searchParams.get('comp') === 'list') {
        const text = await response.clone().text(); inventories.push(text)
        expect(text).not.toContain('payload/')
        expect(text).not.toContain('object-')
      }
      return response
    }))
    let phase = "ordinary"
    const read = (summary = true) => history(new NextRequest('http://tenuvault.internal/api/list-backups', { method: 'POST', body: JSON.stringify({ tenantId: tenant, appId: `budget-${azure}-${legacy}-${phase}`, clientSecret: 'test', subscriptionId: 'local', resourceGroupName: 'local', storageAccountName: azure ? 'budgetstore' : account, summary }) }))
    // Ordinary and 0.5.x legacy summaries retain their base request count plus discovery.
    for (const expected of azure ? [503, 3] : [505, 505]) {
      requests.length = 0
      const response = await read()
      expect(response.status).toBe(200)
      expect((await response.json()).backups).toHaveLength(500)
      expect(requests).toHaveLength(expected)
    }
    const running = `backup-large-${new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '')}`
    const crashed = "backup-large-2020-01-01-000000", finished = "backup-large-2020-01-02-000000"
    for (const folder of [running, crashed, finished]) {
      // Claims are discovery and ownership evidence only. Forged completion fields have no effect.
      await write(LARGE_BACKUP_CONTAINER, `${folder}/${BACKUP_OWNER_FILE}`, { TenantId: folder === finished ? "22222222-2222-2222-2222-222222222222" : tenant, RunId: folder, Status: folder === finished ? "Failed" : "Success", LargeInventory: { version: 1, Status: "Success", Coverage: "Complete", count: 150000 } })
      const entries = []
      for (let at = 0; at < 25; at++) {
        const id = `object-${String(at).padStart(3, '0')}`, snapshot = { id }
        await write(LARGE_BACKUP_CONTAINER, backupBlobName(`${folder}/DeviceConfigurations/${id}.json`), snapshot)
        entries.push({ id, file: `${id}.json`, hash: snapshotHash(snapshot) })
      }
      if (folder === finished) await write(LARGE_BACKUP_CONTAINER, backupBlobName(`${folder}/_index/DeviceConfigurations/000000.json`), entries)
    }
    await write(LARGE_BACKUP_CONTAINER, `${finished}/metadata.json`, { TenantId: tenant, Status: "Success", Coverage: "Complete", Items: {}, LargeItems: { DeviceConfigurations: { version: 1, count: 25, shards: 1, complete: true } }, ItemCounts: { DeviceConfigurations: 25, TotalPolicies: 25 } })
    phase = "mixed"
    for (const expected of azure ? [506, 3] : [510, 508]) {
      requests.length = 0; inventories.length = 0
      const response = await read()
      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.backups).toHaveLength(503)
      expect(result.backups.find((backup: any) => backup.id === running)).toMatchObject({ status: 'running', largeInventory: true, configs: 0 })
      expect(result.backups.find((backup: any) => backup.id === crashed)).toMatchObject({ status: 'incomplete', largeInventory: true, configs: 0 })
      expect(result.backups.find((backup: any) => backup.id === finished)).toMatchObject({ status: 'Success', largeInventory: true, counts: { DeviceConfigurations: 25 } })
      expect(result.backups.filter((backup: any) => !backup.largeInventory).every((backup: any) => backup.policyCount === 1)).toBe(true)
      expect(inventories).toHaveLength(2)
      expect(requests).toHaveLength(expected)
    }
    // The full history path also uses the same bounded discovery, including unfinished runs.
    const full = await read(false)
    expect(full.status).toBe(200)
    expect((await full.json()).backups).toHaveLength(503)
  }, 60_000)
}
