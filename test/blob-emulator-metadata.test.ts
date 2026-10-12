import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { LocalBlobStore } from '../src/main/storage/local-blob-store'
import { handleLocalBlobRequest } from '../src/main/storage/blob-emulator'

const account = 'tvlocal-test'
const container = 'intune-backups'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('returns stored metadata on GET and HEAD with the x-ms-meta prefix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-emulator-meta-')); roots.push(root)
  const store = new LocalBlobStore(root, [randomBytes(32)])
  await store.createContainer(account, container)
  const url = `https://${account}.blob.core.windows.net/${container}/audit/2026-10-12/event.json`
  const put = await handleLocalBlobRequest(store, new Request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-ms-blob-type': 'BlockBlob', 'x-ms-meta-audit_timestamp': '2026-10-12T12:00:00.000Z' },
    body: '{}',
  }))
  expect(put.status).toBe(201)
  for (const method of ['GET', 'HEAD']) {
    const response = await handleLocalBlobRequest(store, new Request(url, { method }))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-ms-meta-audit_timestamp')).toBe('2026-10-12T12:00:00.000Z')
  }
  const plain = await handleLocalBlobRequest(store, new Request(`https://${account}.blob.core.windows.net/${container}/plain.json`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-ms-blob-type': 'BlockBlob' }, body: '{}',
  }))
  expect(plain.status).toBe(201)
  const head = await handleLocalBlobRequest(store, new Request(`https://${account}.blob.core.windows.net/${container}/plain.json`, { method: 'HEAD' }))
  expect([...head.headers.keys()].some((key) => key.startsWith('x-ms-meta-'))).toBe(false)
})
