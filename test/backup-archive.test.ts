import { expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comparableSnapshot } from '../src/shared/intune/compare'
import { importArchive, importConfirmedArchive, reviewArchive } from '../src/main/backup/archive'
import { LocalBlobStore } from '../src/main/storage/local-blob-store'
const tenant = '11111111-1111-1111-1111-111111111111'
const id = 'backup-2026-09-26-120000'
async function archive(change?: (zip: JSZip) => void) {
  const zip = new JSZip(), snapshot = { id: 'policy', displayName: 'Example' }
  zip.file('DeviceConfigurations/policy.json', JSON.stringify(snapshot))
  zip.file('metadata.json', JSON.stringify({ BackupFolder: id, Status: 'Success', Failures: 0, ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 }, Items: { 'DeviceConfigurations/policy': { file: 'policy.json', hash: createHash('sha256').update(JSON.stringify(comparableSnapshot(snapshot))).digest('base64').slice(0,22) } } }))
  zip.file('tenuvault-manifest.json', JSON.stringify({ version: 1, sourceTenantId: tenant, backupId: id }))
  change?.(zip)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
it('reviews a complete archive, preserves source tenant and rejects a duplicate import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-'))
  try {
    const store = new LocalBlobStore(root, [Buffer.alloc(32, 4)]), reviewed = await reviewArchive(await archive())
    expect(reviewed).toMatchObject({ tenantId: tenant, backupId: id, count: 1 })
    await importArchive(store, reviewed)
    expect(JSON.parse((await store.get(`tvlocal-${tenant}`, 'intune-backups', `${id}/metadata.json`)).data.toString())).toMatchObject({ SourceTenantId: tenant, Import: { sha256: reviewed.digest } })
    await expect(importArchive(store, reviewed)).rejects.toThrow('already exists')
  } finally { await rm(root, { recursive: true, force: true }) }
})
it.each(['../evil.json', '/evil.json', 'DeviceConfigurations/../evil.json'])('rejects unsafe path %s before JSZip normalization', async path => {
  await expect(reviewArchive(await archive(zip => { zip.file(path, '{}') }))).rejects.toThrow('Unsafe')
})
it('rejects missing provenance and missing or modified snapshots', async () => {
  await expect(reviewArchive(await archive(zip => { zip.remove('tenuvault-manifest.json') }))).rejects.toThrow('manifest')
  await expect(reviewArchive(await archive(zip => { zip.remove('DeviceConfigurations/policy.json') }))).rejects.toThrow('Missing')
  await expect(reviewArchive(await archive(zip => { zip.file('DeviceConfigurations/policy.json', '{"id":"policy","displayName":"Tampered"}') }))).rejects.toThrow('inventory')
})
it('rejects an archive whose declared expansion exceeds the limit', async () => {
  const raw = await archive(); const offset = raw.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); raw.writeUInt32LE(33 * 1024 * 1024, offset + 24)
  await expect(reviewArchive(raw)).rejects.toThrow('oversized')
})

it('attempts all rollback deletions and preserves the original write failure', async () => {
  let writes = 0
  const cleanup = vi.fn(async () => { throw new Error('cleanup failed') })
  const store = { createContainer: async () => true, list: async () => [], put: async () => { if (++writes === 3) throw new Error('original failure') }, delete: cleanup } as unknown as LocalBlobStore
  const reviewed = await reviewArchive(await archive())
  reviewed.files.set('DeviceConfigurations/second.json', Buffer.from('{}'))
  await expect(importArchive(store, reviewed)).rejects.toThrow('original failure')
  expect(cleanup).toHaveBeenCalledTimes(2)
})

it('claims a license slot for the archive tenant only after the import is confirmed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-'))
  try {
    const store = new LocalBlobStore(root, [Buffer.alloc(32, 4)]), reviewed = await reviewArchive(await archive())
    const list = async () => (await store.list(`tvlocal-${tenant}`, 'intune-backups')).map(blob => blob.name)
    // Cancelling the review leaves the license untouched and imports nothing.
    const license = vi.fn(async () => 'community')
    expect(await importConfirmedArchive(store, reviewed, async () => false, license)).toBe(false)
    expect(license).not.toHaveBeenCalled()
    expect(await list()).toEqual([])
    // A refused license stops a confirmed import before anything is written.
    const refused = vi.fn(async () => { throw new Error('Community covers one tenant') })
    await expect(importConfirmedArchive(store, reviewed, async () => true, refused)).rejects.toThrow('Community covers one tenant')
    expect(refused).toHaveBeenCalledWith(tenant)
    expect(await list()).toEqual([])
    // A confirmed import checks the license after the confirmation, then imports.
    const order: string[] = []
    expect(await importConfirmedArchive(store, reviewed, async () => { order.push('confirm'); return true }, async (id) => { order.push(`license ${id}`) })).toBe(true)
    expect(order).toEqual(['confirm', `license ${tenant}`])
    expect(await list()).toContain(`${id}/metadata.json`)
  } finally { await rm(root, { recursive: true, force: true }) }
})
