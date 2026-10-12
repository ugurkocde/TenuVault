import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'
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


it('lists only metadata names with letters, digits and underscores and no initial digit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tv-emulator-meta-name-')); roots.push(root)
  const store = new LocalBlobStore(root, [randomBytes(32)])
  await store.createContainer(account, container)
  const metadata = { audit_timestamp: 'a&b<c', _allowed1: 'underscore', letters123: 'digits', '1invalid': 'initial digit', 'bad-name': 'hyphen', 'bad.name': 'dot', '': 'empty' }
  const url = `https://${account}.blob.core.windows.net/${container}/event.json`
  const put = await handleLocalBlobRequest(store, new Request(url, {
    method: 'PUT', headers: Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`x-ms-meta-${key}`, value])), body: '{}',
  }))
  expect(put.status).toBe(201)
  const listed = await handleLocalBlobRequest(store, new Request(`https://${account}.blob.core.windows.net/${container}?restype=container&comp=list&include=metadata`))
  expect(listed.status).toBe(200)
  const text = await listed.text()
  const document = new DOMParser().parseFromString(text, 'application/xml')
  const element = document.getElementsByTagName('Metadata')[0]!
  expect(Array.from(element.childNodes).filter(node => node.nodeType === 1).map(node => [node.nodeName, node.textContent])).toEqual([
    ['_allowed1', 'underscore'], ['audit_timestamp', 'a&b<c'], ['letters123', 'digits'],
  ])
  for (const key of ['1invalid', 'bad-name', 'bad.name', '']) expect(text).not.toContain(`<${key}>`)
})
