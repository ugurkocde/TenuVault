import { expect, it, vi } from 'vitest'
import { isLegacySealed, legacyAzureReader, openLegacySealed, registerStorageToken } from '../src/main/storage/azure-seal'
import { createBridgedFetch } from '../src/main/api/fetch-bridge'
import { FetchApplicationError, FetchPreconditionError, LegacySealedError, withNetworkErrors } from '../src/main/api/network-error'
import { isLegacyOtherTenantError, isLegacySealedError, LEGACY_OTHER_TENANT_MESSAGE, LEGACY_SEALED_MESSAGE } from '../src/shared/legacy-sealed'
import { sealLegacyAzure } from './legacy-seal'
const tenant = '11111111-1111-1111-1111-111111111111', master = Buffer.alloc(32, 4)
const url = new URL('https://example.blob.core.windows.net/intune-backups/backup-1/DeviceConfigurations/policy.json')

it('opens a legacy sealed blob with any key in the keyring, bound to tenant, account and path', () => {
  const plain = Buffer.from('{"id":"policy","omaSecret":"dummy-secret"}'), sealed = sealLegacyAzure(plain, master, tenant, url)
  expect(isLegacySealed(sealed)).toBe(true)
  expect(isLegacySealed(plain)).toBe(false)
  expect(openLegacySealed(sealed, [Buffer.alloc(32, 8), master], tenant, url)).toEqual(plain)
  for (const changed of [new URL(url.href.replace('example.', 'other.')), new URL(url.href + '-changed')]) expect(() => openLegacySealed(sealed, [master], tenant, changed)).toThrow('No recovery key')
  expect(() => openLegacySealed(sealed, [master], tenant.replace('1111', '2222'), url)).toThrow('No recovery key')
})

it('sends uploads to Azure as plain JSON, exactly as the writer made them', async () => {
  const body = '{"id":"policy","omaSettings":[{"value":"dummy-secret"}]}'
  const init = { method: 'PUT', headers: { Authorization: 'Bearer no-registered-token', 'content-type': 'application/json', 'x-ms-blob-type': 'BlockBlob' }, body }
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 201 }))
  const reader = legacyAzureReader(fetch, () => { throw new Error('keys are never needed for a write') })
  expect((await reader(url, init)).status).toBe(201)
  expect(fetch).toHaveBeenCalledWith(url, init)
  const sent = new Request(url, fetch.mock.calls[0]![1])
  expect(sent.headers.get('content-type')).toBe('application/json')
  const text = await sent.text()
  expect(text).toBe(body)
  expect(text.startsWith('TVAZ1')).toBe(false)
})

it('returns plain blobs unchanged, with no tenant context or key needed', async () => {
  const fetch = vi.fn(async () => Response.json({ id: 'plain', value: 'readable' }, { headers: { 'content-type': 'application/json' } }))
  const reader = legacyAzureReader(fetch, () => { throw new Error('keys are never needed for a plain blob') })
  const response = await reader(url, { headers: { Authorization: 'Bearer unregistered' } })
  expect(await response.json()).toEqual({ id: 'plain', value: 'readable' })
  expect(response.headers.get('x-tenuvault-authenticated')).toBeNull()
})

it('reads a mixed container: plain and legacy sealed blobs side by side', async () => {
  registerStorageToken('mixed-token', tenant)
  const sealedUrl = new URL('https://example.blob.core.windows.net/intune-backups/backup-2024-01-01-000000/metadata.json')
  const blobs = new Map<string, Uint8Array>([
    [url.pathname, new TextEncoder().encode('{"id":"new"}')],
    [sealedUrl.pathname, new Uint8Array(sealLegacyAzure(Buffer.from('{"id":"old"}'), master, tenant, sealedUrl))],
  ])
  const reader = legacyAzureReader(async (input) => new Response(new Uint8Array(blobs.get(new URL(String(input)).pathname)!), { headers: { 'content-type': 'application/octet-stream' } }), () => [master])
  const headers = { Authorization: 'Bearer mixed-token' }
  expect(await (await reader(url.href, { headers })).json()).toEqual({ id: 'new' })
  const opened = await reader(sealedUrl.href, { headers })
  expect(opened.headers.get('content-type')).toBe('application/json')
  expect(await opened.json()).toEqual({ id: 'old' })
})

it.each(['missing key', 'wrong key', 'another tenant', 'damaged ciphertext', 'truncated envelope'])('names the missing key for a legacy sealed blob: %s', async failure => {
  registerStorageToken('read-token', tenant)
  let raw = sealLegacyAzure(Buffer.from('{"id":"policy"}'), master, failure === 'another tenant' ? tenant.replace('1111', '2222') : tenant, url)
  if (failure === 'damaged ciphertext') raw[raw.length - 1]! ^= 1
  if (failure === 'truncated envelope') raw = raw.subarray(0, 8)
  const reader = withNetworkErrors(legacyAzureReader(async () => new Response(new Uint8Array(raw)), () => failure === 'missing key' ? [] : failure === 'wrong key' ? [Buffer.alloc(32, 8)] : [master]))
  const pending = reader(url, { headers: { Authorization: 'Bearer read-token' } })
  await expect(pending).rejects.toBeInstanceOf(LegacySealedError)
  await expect(pending).rejects.toBeInstanceOf(FetchApplicationError)
  await expect(pending).rejects.toMatchObject({ name: 'FetchApplicationError', message: LEGACY_SEALED_MESSAGE })
  expect(isLegacySealedError(await pending.catch((error: unknown) => error))).toBe(true)
})

it('reports a key store failure as an application failure, not a missing key', async () => {
  registerStorageToken('keystore-token', tenant)
  const keyError = new Error('Recovery keys are unavailable on this device.')
  const raw = sealLegacyAzure(Buffer.from('{"id":"policy"}'), master, tenant, url)
  const reader = legacyAzureReader(async () => new Response(new Uint8Array(raw)), () => { throw keyError })
  const failure = await reader(url, { headers: { Authorization: 'Bearer keystore-token' } }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(FetchApplicationError)
  expect(failure).toMatchObject({ message: keyError.message, cause: keyError })
  expect(isLegacySealedError(failure)).toBe(false)
})

it('needs the tenant of a registered storage token only to open a legacy sealed blob', async () => {
  const raw = sealLegacyAzure(Buffer.from('{"id":"policy"}'), master, tenant, url)
  const reader = legacyAzureReader(async () => new Response(new Uint8Array(raw)), () => [master])
  await expect(reader(url, { headers: { Authorization: 'Bearer never-registered' } })).rejects.toBeInstanceOf(FetchPreconditionError)
})

it('passes a plain blob that is not JSON through for the caller to judge', async () => {
  const reader = legacyAzureReader(async () => new Response('Invalid JSON'), () => [master])
  expect(await (await reader(url, { headers: { Authorization: 'Bearer x' } })).text()).toBe('Invalid JSON')
})

it.each([new TypeError('Connection reset while reading body'), new DOMException('The request timed out', 'TimeoutError')])('preserves a successful response body transport failure: %s', async error => {
  const reader = legacyAzureReader(async () => new Response(new ReadableStream({ start(controller) { controller.error(error) } })), () => [master])
  await expect(reader(url, { headers: { Authorization: 'Bearer body-token' } })).rejects.toBe(error)
})

it('passes every other request through unchanged, including block uploads and other containers', async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'DELETE') return new Response(null, { status: 202 })
    if (method === 'PUT' || method === 'POST') return new Response(null, { status: 201 })
    if (String(input).includes('comp=list')) return new Response('<EnumerationResults></EnumerationResults>', { headers: { 'content-type': 'application/xml' } })
    return Response.json({ id: 'version' })
  })
  const reader = legacyAzureReader(fetch, () => [master])
  const headers = { Authorization: 'Bearer [REDACTED]' }
  expect((await reader('https://example.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=backup-1/', { headers })).status).toBe(200)
  expect((await reader('https://example.blob.core.windows.net/intune-backups?restype=container', { method: 'PUT', headers })).status).toBe(201)
  expect((await reader('https://example.blob.core.windows.net/intune-backups/backup-1/policy.json?comp=block&blockid=AAAA', { method: 'PUT', headers, body: '{"id":"block"}' })).status).toBe(201)
  expect((await reader(url, { method: 'POST', headers, body: '{}' })).status).toBe(201)
  expect((await reader(url, { method: 'DELETE', headers })).status).toBe(202)
  expect((await reader(`${url.href}?sv=2021-06-08&sig=test`, { headers })).status).toBe(200)
  expect((await reader('https://example.blob.core.windows.net/tenant-metadata/tenant/metadata.json', { method: 'PUT', body: '{"note":"plain-metadata"}' })).status).toBe(201)
  expect(fetch).toHaveBeenCalledTimes(7)
})

it.each(['GET', 'PUT'])('forwards %s aborts through the bridge, reader and network wrapper', async method => {
  registerStorageToken('abort-token', tenant)
  const controller = new AbortController()
  let networkSignal!: AbortSignal
  let arrived!: () => void
  const started = new Promise<void>(resolve => { arrived = resolve })
  const networkFetch: typeof fetch = async (input, init) => {
    networkSignal = init?.signal ?? (input as Request).signal
    arrived()
    return new Promise((_resolve, reject) => {
      networkSignal.addEventListener('abort', () => reject(networkSignal.reason), { once: true })
    })
  }
  const bridge = createBridgedFetch({
    dispatch: async () => new Response(),
    getDelegatedToken: async () => ({ accessToken: 'abort-token', expiresOn: null }),
    fetch: legacyAzureReader(withNetworkErrors(networkFetch), () => [master]),
  })
  const pending = bridge(url, { method, signal: controller.signal, headers: { Authorization: 'Bearer abort-token' }, ...(method === 'PUT' ? { body: '{}' } : {}) })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await started
  expect(networkSignal.aborted).toBe(false)
  controller.abort()
  expect(networkSignal.aborted).toBe(true)
  await rejected
})

it('tells a legacy blob of another tenant signed in on this device apart from a missing key', async () => {
  const other = '33333333-3333-3333-3333-333333333333'
  registerStorageToken('own-token', tenant)
  registerStorageToken('other-token', other)
  const raw = sealLegacyAzure(Buffer.from('{"id":"theirs"}'), master, other, url)
  const reader = legacyAzureReader(async () => new Response(new Uint8Array(raw)), () => [master])
  const failure = await reader(url, { headers: { Authorization: 'Bearer own-token' } }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(LegacySealedError)
  expect(failure).toMatchObject({ name: 'FetchApplicationError', message: LEGACY_OTHER_TENANT_MESSAGE })
  expect(isLegacyOtherTenantError(failure)).toBe(true)
  expect(isLegacySealedError(failure)).toBe(false)
})
