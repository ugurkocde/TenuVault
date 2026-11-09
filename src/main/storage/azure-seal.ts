import { createDecipheriv, createHash, hkdfSync } from 'node:crypto'
import { FetchApplicationError, FetchPreconditionError, LegacySealedError, OversizedSealedError } from '../api/network-error'
import { MAX_BACKUP_ARCHIVE_BYTES } from '../../shared/constants'

/**
 * Reads backups in Azure storage. New Azure backups are plain JSON: Azure encrypts them at rest and
 * the customer's role assignments decide who reads them, so every admin with access sees the same
 * backups. Versions before that encrypted each Azure blob with the device key in a `TVAZ1`
 * envelope bound to the tenant, account and path. Those legacy blobs are opened here with the
 * device keyring, so older backups keep working on a device that has their key; nothing is sealed.
 */
const MAGIC = Buffer.from('TVAZ1\n')
// Legacy blobs are bound to the tenant of the storage token that reads them.
const tokens = new Map<string, { tenant: string; expires: number }>()
// Every tenant that used Azure storage on this device, so a legacy blob of another one is named as such.
const knownTenants = new Set<string>()
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
export function registerStorageToken(token: string, tenant: string): void {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tenant)) throw new Error('Invalid backup tenant')
  for (const [key, value] of tokens) if (value.expires < Date.now()) tokens.delete(key)
  tokens.set(digest(token), { tenant: tenant.toLowerCase(), expires: Date.now() + 3600_000 })
  knownTenants.add(tenant.toLowerCase())
}
const key = (master: Buffer) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'tenuvault-azure-backup-v1', 32))
function aad(tenant: string, url: URL) { return Buffer.from(JSON.stringify([tenant.toLowerCase(), url.hostname, decodeURIComponent(url.pathname)])) }

/** Whether a blob is in the legacy `TVAZ1` envelope. */
export function isLegacySealed(raw: Buffer): boolean {
  return raw.subarray(0, MAGIC.length).equals(MAGIC)
}

/** Opens a legacy sealed blob with the first key that authenticates it; throws when none does. */
export function openLegacySealed(raw: Buffer, masters: Buffer[], tenant: string, url: URL): Buffer {
  for (const master of masters) {
    try {
      const start = MAGIC.length, decipher = createDecipheriv('aes-256-gcm', key(master), raw.subarray(start, start + 12))
      decipher.setAAD(aad(tenant, url)); decipher.setAuthTag(raw.subarray(start + 12, start + 28))
      return Buffer.concat([decipher.update(raw.subarray(start + 28)), decipher.final()])
    } catch { /* Try older recovery keys. */ }
  }
  throw new Error('No recovery key on this device opens this backup for this tenant.')
}

/** A blob read in the backup container: a GET without a query (listings and versions pass through). */
function isBackupBlobRead(url: URL, method: string): boolean {
  return method === 'GET' && !url.search && /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname)
    && url.pathname.startsWith('/intune-backups/')
}

/** Reads at least `size` bytes from the start of a stream, or all of it when it is shorter. */
async function peek(stream: ReadableStreamDefaultReader<Uint8Array>, size: number): Promise<{ bytes: Uint8Array; done: boolean }> {
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < size) {
    const { done, value } = await stream.read()
    if (done) return { bytes: concat(chunks, total), done: true }
    if (value?.byteLength) { chunks.push(value); total += value.byteLength }
  }
  return { bytes: concat(chunks, total), done: false }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return merged
}

/** The original body: the peeked bytes, then the rest of the stream as the caller reads it. */
function replay(prefix: Uint8Array, done: boolean, stream: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.byteLength) controller.enqueue(prefix)
      if (done) controller.close()
    },
    async pull(controller) {
      const { done: ended, value } = await stream.read()
      if (ended) controller.close()
      else if (value) controller.enqueue(value)
    },
    cancel(reason) { return stream.cancel(reason) },
  })
}

/** A legacy sealed envelope, read whole up to the backup size limit and refused beyond it. */
async function readSealed(prefix: Uint8Array, done: boolean, stream: ReadableStreamDefaultReader<Uint8Array>): Promise<Buffer> {
  const chunks = [prefix]
  let total = prefix.byteLength
  for (let ended = done; !ended;) {
    const { done: last, value } = await stream.read()
    ended = last
    if (!value?.byteLength) continue
    total += value.byteLength
    if (total > MAX_BACKUP_ARCHIVE_BYTES) {
      try { await stream.cancel() } catch { /* The refusal is the result. */ }
      throw new OversizedSealedError()
    }
    chunks.push(value)
  }
  return Buffer.from(concat(chunks, total))
}

/**
 * Main-process boundary for Azure backup storage. Writes and every other request pass through
 * unchanged. A blob read streams through as stored, unless it is a legacy sealed blob: that one is
 * read up to the backup size limit and opened with the device keyring, or fails with a
 * LegacySealedError that names the missing key (an OversizedSealedError beyond the limit).
 */
export function legacyAzureReader(fetchImpl: typeof fetch, keys: () => Buffer[]): typeof fetch {
  return async (input, init) => {
    let url: URL
    try { url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) }
    catch { return fetchImpl(input, init) }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (!isBackupBlobRead(url, method)) return fetchImpl(input, init)
    const response = await fetchImpl(input, init)
    if (!response.ok || !response.body) return response
    // Only the first bytes are read to tell the formats apart, so a plain blob streams through to the
    // caller's own size cap instead of being buffered here. Body reads can fail in transit; only
    // failures after a complete read are application errors.
    const stream = response.body.getReader()
    const prefix = await peek(stream, MAGIC.length)
    const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding')
    if (!isLegacySealed(Buffer.from(prefix.bytes))) return new Response(replay(prefix.bytes, prefix.done, stream), { status: response.status, statusText: response.statusText, headers })
    const raw = await readSealed(prefix.bytes, prefix.done, stream)
    const bearer = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization')?.replace(/^Bearer /i, '') ?? ''
    const context = tokens.get(digest(bearer))
    if (!context || context.expires < Date.now()) throw new FetchPreconditionError(new Error('Backup tenant context is unavailable. Sign in again.'))
    let keyring: Buffer[]
    try { keyring = keys() }
    catch (error) { throw new FetchApplicationError(error) }
    let data: Buffer
    try { data = openLegacySealed(raw, keyring, context.tenant, url) }
    catch (error) {
      // In a container several tenants share, a key here may open it for another tenant: that is
      // not a missing key, and that tenant's content is never returned.
      const otherTenant = [...knownTenants].some((tenant) => {
        if (tenant === context.tenant) return false
        try { openLegacySealed(raw, keyring, tenant, url); return true } catch { return false }
      })
      throw new LegacySealedError(error, otherTenant)
    }
    headers.set('content-type', 'application/json')
    return new Response(new Uint8Array(data), { status: response.status, headers })
  }
}
