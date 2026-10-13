import { expect, it, vi } from 'vitest'
import { encryptedAzureFetch, openAzure, registerStorageToken, sealAzure } from '../src/main/storage/azure-seal'
import { Restorer } from '../src/portal/lib/policies/graph-restore'
import { createBridgedFetch } from '../src/main/api/fetch-bridge'
import { FetchApplicationError, withNetworkErrors } from '../src/main/api/network-error'
const tenant = '11111111-1111-1111-1111-111111111111', master = Buffer.alloc(32, 4)
const url = new URL('https://example.blob.core.windows.net/intune-backups/backup-1/DeviceConfigurations/policy.json')
it('encrypts uploads and binds authentication to tenant, account and path', async () => {
  const plain = Buffer.from('{"id":"policy","omaSecret":"dummy-secret"}'), sealed = sealAzure(plain, master, tenant, url)
  expect(sealed.includes(Buffer.from('dummy-secret'))).toBe(false)
  expect(openAzure(sealed, [Buffer.alloc(32, 8), master], tenant, url)).toEqual({ data: plain, authenticated: true })
  for (const changed of [new URL(url.href.replace('example.', 'other.')), new URL(url.href + '-changed')]) expect(() => openAzure(sealed, [master], tenant, changed)).toThrow('authentication')
  expect(() => openAzure(sealed, [master], tenant.replace('1111', '2222'), url)).toThrow('authentication')
  sealed[sealed.length - 1]! ^= 1
  const graph = vi.fn(); const restorer = new Restorer(graph, { mode: 'replace', assignments: false })
  await expect((async () => { const opened = openAzure(sealed, [master], tenant, url); return restorer.restore('backup-1/DeviceConfigurations/policy.json', JSON.parse(opened.data.toString())) })()).rejects.toThrow('authentication')
  expect(graph).not.toHaveBeenCalled()
})
it('writes ciphertext at the network boundary and marks plaintext reads as unverified', async () => {
  registerStorageToken('storage-token', tenant)
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request
    if (request.method === 'PUT') expect(await request.text()).not.toContain('dummy-secret')
    return request.method === 'PUT' ? new Response(null, { status: 201 }) : Response.json({ id: 'legacy' }, { headers: { 'x-tenuvault-authenticated': 'true' } })
  })
  const bridge = encryptedAzureFetch(fetch, () => [master], () => {})
  await bridge(url, { method: 'PUT', headers: { Authorization: 'Bearer storage-token' }, body: '{"omaSecret":"dummy-secret"}' })
  expect((await bridge(url, { headers: { Authorization: 'Bearer storage-token' } })).headers.get('x-tenuvault-authenticated')).toBe('false')
})
it('requires the recovery-key export before uploading', async () => {
  registerStorageToken('token', tenant)
  const fetch = vi.fn()
  const bridge = encryptedAzureFetch(fetch, () => [master], () => { throw new Error('Save recovery key') })
  await expect(bridge(url, { method: 'PUT', headers: { Authorization: 'Bearer token' }, body: '{}' })).rejects.toThrow('recovery')
  expect(fetch).not.toHaveBeenCalled()
})
it.each(['missing key', 'wrong key', 'damaged ciphertext', 'truncated envelope', 'invalid legacy JSON', 'key store failure'])('marks a fully read %s as an application failure', async failure => {
  registerStorageToken('read-token', tenant)
  let raw = sealAzure(Buffer.from('{"id":"policy"}'), master, tenant, url)
  if (failure === 'damaged ciphertext') raw[raw.length - 1]! ^= 1
  if (failure === 'truncated envelope') raw = raw.subarray(0, 8)
  if (failure === 'invalid legacy JSON') raw = Buffer.from('Invalid JSON')
  const keyError = new Error('Recovery keys are unavailable on this device.')
  const bridge = withNetworkErrors(encryptedAzureFetch(async () => new Response(new Uint8Array(raw)), () => {
    if (failure === 'key store failure') throw keyError
    return failure === 'missing key' ? [] : failure === 'wrong key' ? [Buffer.alloc(32, 8)] : [master]
  }, () => {}))
  const pending = bridge(url, { headers: { Authorization: 'Bearer read-token' } })
  await expect(pending).rejects.toBeInstanceOf(FetchApplicationError)
  await expect(pending).rejects.toThrow(failure === 'key store failure' ? keyError.message : 'Backup authentication failed')
  if (failure === 'key store failure') await expect(pending).rejects.toMatchObject({ cause: keyError })
})
it.each([new TypeError('Connection reset while reading body'), new DOMException('The request timed out', 'TimeoutError')])('preserves a successful response body transport failure: %s', async error => {
  registerStorageToken('body-token', tenant)
  const bridge = encryptedAzureFetch(async () => new Response(new ReadableStream({ start(controller) { controller.error(error) } })), () => [master], () => {})
  await expect(bridge(url, { headers: { Authorization: 'Bearer body-token' } })).rejects.toBe(error)
})
it('refuses body-bearing requests to the backup container that the seal does not handle', async () => {
  registerStorageToken('seal-token', tenant)
  const fetch = vi.fn(async () => new Response(null, { status: 201 }))
  const bridge = encryptedAzureFetch(fetch, () => [master], () => {})
  const headers = { Authorization: 'Bearer [REDACTED]' }
  await expect(bridge('https://example.blob.core.windows.net/intune-backups/backup-1/policy.json?comp=block&blockid=AAAA', { method: 'PUT', headers, body: '{"omaSecret":"dummy-secret"}' })).rejects.toThrow('unsealed')
  await expect(bridge(url, { method: 'POST', headers, body: '{}' })).rejects.toThrow('unsealed')
  await expect(bridge('https://example.blob.core.windows.net/intune-backups?restype=container', { method: 'PUT', headers, body: '{}' })).rejects.toThrow('unsealed')
  expect(fetch).not.toHaveBeenCalled()
})
it('keeps container, listing, delete and read operations on the backup container working', async () => {
  registerStorageToken('ops-token', tenant)
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request
    if (request.method === 'DELETE') return new Response(null, { status: 202 })
    if (request.method === 'PUT') return new Response(null, { status: 201 })
    if (request.url.includes('comp=list')) return new Response('<EnumerationResults></EnumerationResults>', { headers: { 'content-type': 'application/xml' } })
    return Response.json({ id: 'legacy' })
  })
  const bridge = encryptedAzureFetch(fetch, () => [master], () => {})
  const headers = { Authorization: 'Bearer [REDACTED]' }
  expect((await bridge('https://example.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=backup-1/', { headers })).status).toBe(200)
  expect((await bridge('https://example.blob.core.windows.net/intune-backups?restype=container', { method: 'PUT', headers })).status).toBe(201)
  expect((await bridge(url, { method: 'DELETE', headers })).status).toBe(202)
  expect((await bridge(`${url.href}?sv=2021-06-08&sig=test`, { headers })).status).toBe(200)
  expect(fetch).toHaveBeenCalledTimes(4)
})
it('still passes body-bearing requests to other containers through', async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    expect(await (input as Request).text()).toContain('plain-metadata')
    return new Response(null, { status: 201 })
  })
  const bridge = encryptedAzureFetch(fetch, () => [master], () => {})
  const response = await bridge('https://example.blob.core.windows.net/tenant-metadata/tenant/metadata.json', { method: 'PUT', body: '{"note":"plain-metadata"}' })
  expect(response.status).toBe(201)
  expect(fetch).toHaveBeenCalledTimes(1)
})
it.each(['GET', 'PUT'])('forwards %s aborts through the bridge, seal and network wrapper', async method => {
  registerStorageToken('abort-token', tenant)
  const controller = new AbortController()
  let networkSignal!: AbortSignal
  let arrived!: () => void
  const started = new Promise<void>(resolve => { arrived = resolve })
  const networkFetch: typeof fetch = async input => {
    networkSignal = (input as Request).signal
    arrived()
    return new Promise((_resolve, reject) => {
      networkSignal.addEventListener('abort', () => reject(networkSignal.reason), { once: true })
    })
  }
  const bridge = createBridgedFetch({
    dispatch: async () => new Response(),
    getDelegatedToken: async () => ({ accessToken: 'abort-token', expiresOn: null }),
    fetch: encryptedAzureFetch(withNetworkErrors(networkFetch), () => [master], () => {}),
  })
  const pending = bridge(url, { method, signal: controller.signal, headers: { Authorization: 'Bearer abort-token' }, ...(method === 'PUT' ? { body: '{}' } : {}) })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await started
  expect(networkSignal.aborted).toBe(false)
  controller.abort()
  expect(networkSignal.aborted).toBe(true)
  await rejected
})
