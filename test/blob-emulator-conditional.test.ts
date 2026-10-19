import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { LocalBlobStore } from '../src/main/storage/local-blob-store'
import { handleLocalBlobRequest } from '../src/main/storage/blob-emulator'

const account = 'tvlocal-test'
const container = 'intune-backups'
const url = `https://${account}.blob.core.windows.net/${container}/metadata/revert-history.json`
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tv-emulator-cond-')); roots.push(root)
  const store = new LocalBlobStore(root, [randomBytes(32)])
  await store.createContainer(account, container)
  const sendTo = (target: string) => (method: string, headers: Record<string, string> = {}, body?: string) =>
    handleLocalBlobRequest(store, new Request(target, { method, headers: { 'x-ms-blob-type': 'BlockBlob', ...headers }, ...(body === undefined ? {} : { body }) }))
  return { send: sendTo(url), sendTo }
}

it('writes with If-Match only while the ETag from the last read is current', async () => {
  const { send } = await setup()
  expect((await send('PUT', {}, '{"v":1}')).status).toBe(201)
  const read = await send('GET')
  const tag = read.headers.get('etag')!
  expect(tag).toBeTruthy()

  const first = await send('PUT', { 'If-Match': tag }, '{"v":2}')
  expect(first.status).toBe(201)
  expect(first.headers.get('etag')).not.toBe(tag)
  // A second writer that read the same version is refused and keeps nothing.
  const stale = await send('PUT', { 'If-Match': tag }, '{"v":3}')
  expect(stale.status).toBe(412)
  expect(await stale.text()).toContain('ConditionNotMet')
  expect(await (await send('GET')).json()).toEqual({ v: 2 })
  expect((await send('GET')).headers.get('etag')).toBe(first.headers.get('etag'))
})

it('refuses If-Match on a missing blob and accepts * on an existing one', async () => {
  const { send } = await setup()
  expect((await send('PUT', { 'If-Match': '*' }, '{}')).status).toBe(412)
  expect((await send('GET')).status).toBe(404)
  expect((await send('PUT', { 'If-None-Match': '*' }, '{"v":1}')).status).toBe(201)
  expect((await send('PUT', { 'If-None-Match': '*' }, '{"v":2}')).status).toBe(412)
  expect((await send('PUT', { 'If-Match': '*' }, '{"v":3}')).status).toBe(201)
  expect(await (await send('GET')).json()).toEqual({ v: 3 })
})

it('lets only one of two concurrent writes with the same If-Match succeed', async () => {
  const { send } = await setup()
  expect((await send('PUT', {}, '{"v":0}')).status).toBe(201)
  const tag = (await send('GET')).headers.get('etag')!
  const results = await Promise.all([send('PUT', { 'If-Match': tag }, '{"v":"a"}'), send('PUT', { 'If-Match': tag }, '{"v":"b"}')])
  expect(results.map(response => response.status).sort()).toEqual([201, 412])
})

it('keeps a tenant revert history under its nested path apart from the shared one', async () => {
  const { send, sendTo } = await setup()
  const tenant = sendTo(url.replace('/metadata/', '/metadata/11111111-1111-4111-8111-111111111111/'))
  expect((await send('PUT', {}, '{"shared":true}')).status).toBe(201)
  expect((await tenant('GET')).status).toBe(404)
  expect((await tenant('PUT', { 'If-None-Match': '*' }, '{"tenant":true}')).status).toBe(201)
  expect(await (await tenant('GET')).json()).toEqual({ tenant: true })
  expect(await (await send('GET')).json()).toEqual({ shared: true })
})
