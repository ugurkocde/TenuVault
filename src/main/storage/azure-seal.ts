import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
const MAGIC = Buffer.from('TVAZ1\n')
const tokens = new Map<string, { tenant: string; expires: number }>()
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
export function registerStorageToken(token: string, tenant: string): void {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tenant)) throw new Error('Invalid backup tenant')
  for (const [key, value] of tokens) if (value.expires < Date.now()) tokens.delete(key)
  tokens.set(digest(token), { tenant: tenant.toLowerCase(), expires: Date.now() + 3600_000 })
}
const key = (master: Buffer) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'tenuvault-azure-backup-v1', 32))
function aad(tenant: string, url: URL) { return Buffer.from(JSON.stringify([tenant.toLowerCase(), url.hostname, decodeURIComponent(url.pathname)])) }
export function sealAzure(plain: Buffer, master: Buffer, tenant: string, url: URL): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(master), iv)
  cipher.setAAD(aad(tenant, url))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}
export function openAzure(raw: Buffer, masters: Buffer[], tenant: string, url: URL): { data: Buffer; authenticated: boolean } {
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    // Unknown envelope/corrupt ciphertext must not masquerade as legacy JSON.
    try { const value = JSON.parse(raw.toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error() }
    catch { throw new Error('Backup authentication failed or the legacy snapshot is invalid') }
    return { data: raw, authenticated: false }
  }
  for (const master of masters) {
    try {
      const start = MAGIC.length, decipher = createDecipheriv('aes-256-gcm', key(master), raw.subarray(start, start + 12))
      decipher.setAAD(aad(tenant, url)); decipher.setAuthTag(raw.subarray(start + 12, start + 28))
      return { data: Buffer.concat([decipher.update(raw.subarray(start + 28)), decipher.final()]), authenticated: true }
    } catch { /* Try older recovery keys. */ }
  }
  throw new Error('Backup authentication failed. Import the correct recovery key or recover an undamaged snapshot.')
}
/** Main-process boundary: ciphertext is the only backup payload sent to Azure. */
export function encryptedAzureFetch(fetchImpl: typeof fetch, keys: () => Buffer[], requireRecovery: () => void): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) || !url.pathname.startsWith('/intune-backups/') || url.search || !['GET', 'PUT'].includes(request.method)) return fetchImpl(request)
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? ''
    const context = tokens.get(digest(bearer))
    if (!context || context.expires < Date.now()) throw new Error('Backup tenant context is unavailable. Sign in again.')
    if (request.method === 'PUT') {
      requireRecovery()
      const body = sealAzure(Buffer.from(await request.arrayBuffer()), keys()[0]!, context.tenant, url)
      const headers = new Headers(request.headers); headers.set('content-type', 'application/octet-stream'); headers.delete('content-length')
      return fetchImpl(new Request(url, { method: 'PUT', headers, body: new Uint8Array(body), signal: request.signal }))
    }
    const response = await fetchImpl(request)
    if (!response.ok) return response
    const opened = openAzure(Buffer.from(await response.arrayBuffer()), keys(), context.tenant, url)
    const headers = new Headers(response.headers); headers.set('content-type', 'application/json'); headers.set('x-tenuvault-authenticated', String(opened.authenticated)); headers.delete('content-length'); headers.delete('content-encoding')
    return new Response(new Uint8Array(opened.data), { status: response.status, headers })
  }
}
