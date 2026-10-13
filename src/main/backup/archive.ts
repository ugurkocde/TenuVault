import JSZip from 'jszip'
import type { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { typeForFolder } from '../../shared/intune/registry'
import { comparableSnapshot } from '../../shared/intune/compare'
const snapshotHash = (value: Record<string, any>) => createHash('sha256').update(JSON.stringify(comparableSnapshot(value))).digest('base64').slice(0, 22)
import { LocalBlobStore } from '../storage/local-blob-store'
import { MAX_BACKUP_ARCHIVE_BYTES, MAX_BACKUP_ARCHIVE_FILES } from '../../shared/constants'

const MAX = MAX_BACKUP_ARCHIVE_BYTES
const guid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
export interface ReviewedArchive { tenantId: string; backupId: string; digest: string; files: Map<string, Buffer>; count: number }
/** Validate the central directory before JSZip can normalize names or replace duplicates. */
function inspectDirectory(raw: Buffer): void {
  let end = raw.length - 22
  while (end >= Math.max(0, raw.length - 65557) && raw.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0 || raw.readUInt32LE(end) !== 0x06054b50 || end + 22 + raw.readUInt16LE(end + 20) !== raw.length) throw new Error('Invalid ZIP directory')
  const count = raw.readUInt16LE(end + 10)
  if (raw.readUInt16LE(end + 4) || raw.readUInt16LE(end + 6) || count !== raw.readUInt16LE(end + 8) || count > MAX_BACKUP_ARCHIVE_FILES) throw new Error('Unsupported ZIP layout')
  let offset = raw.readUInt32LE(end + 16), total = 0
  const names = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || raw.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry')
    const length = raw.readUInt16LE(offset + 28), extra = raw.readUInt16LE(offset + 30), comment = raw.readUInt16LE(offset + 32)
    const name = raw.subarray(offset + 46, offset + 46 + length).toString('utf8')
    const flags = raw.readUInt16LE(offset + 8), method = raw.readUInt16LE(offset + 10)
    const mode = raw.readUInt32LE(offset + 38) >>> 16
    total += raw.readUInt32LE(offset + 24)
    // Control characters are intentionally rejected in archive entry names.
    // oxlint-disable-next-line no-control-regex
    if (flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || total > MAX || !name || name.includes('\\') || name.startsWith('/') || name.includes(':') || /[\x00-\x1f]/.test(name) || name.split('/').some(p => p === '.' || p === '..') || names.has(name.toLowerCase())) throw new Error('Unsafe or oversized ZIP entry')
    names.add(name.toLowerCase()); offset += 46 + length + extra + comment
  }
  if (offset !== end) throw new Error('Unsupported ZIP directory')
}
async function bounded(entry: JSZip.JSZipObject, remaining: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0
    const stream = entry.nodeStream('nodebuffer') as Readable
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > Math.min(8 * 1024 * 1024, remaining)) { stream.destroy(new Error('Archive expands beyond the import limit')); return }
      chunks.push(chunk)
    }).on('error', reject).on('end', () => resolve(Buffer.concat(chunks))).resume()
  })
}
export async function reviewArchive(raw: Buffer): Promise<ReviewedArchive> {
  if (raw.length < 22 || raw.length > MAX) throw new Error('Choose a ZIP archive smaller than 32 MiB')
  inspectDirectory(raw)
  const zip = await JSZip.loadAsync(raw)
  const files = new Map<string, Buffer>(); let total = 0
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    if (entry.name !== 'metadata.json' && entry.name !== 'tenuvault-manifest.json' && !/^[A-Za-z0-9]+\/[^/]+\.json$/.test(entry.name)) throw new Error('Archive contains an unsupported file')
    const content = await bounded(entry, MAX - total); total += content.length; files.set(entry.name, content)
  }
  const parse = (name: string): unknown => { try { return JSON.parse(files.get(name)?.toString('utf8') ?? '') } catch { throw new Error(`Missing or invalid ${name}`) } }
  const manifest = parse('tenuvault-manifest.json'), metadata = parse('metadata.json')
  if (!object(manifest) || manifest.version !== 1 || !guid.test(manifest.sourceTenantId) || !/^backup-\d{4}-\d{2}-\d{2}-\d{6}$/.test(manifest.backupId)) throw new Error('A TenuVault export manifest with source tenant identity is required')
  if (!object(metadata) || metadata.BackupFolder !== manifest.backupId || metadata.Status !== 'Success' || metadata.Failures !== 0 || !object(metadata.Items) || !object(metadata.ItemCounts)) throw new Error('Only complete backups with item metadata can be imported')
  const expected = new Set<string>(); const counts: Record<string, number> = {}
  for (const [identity, item] of Object.entries(metadata.Items)) {
    const [folder, id, ...rest] = identity.split('/')
    if (!folder || !id || rest.length || !typeForFolder(folder) || !object(item) || typeof item.file !== 'string' || !/^[^/\\]+\.json$/.test(item.file)) throw new Error('Unsupported backup item')
    const path = `${folder}/${item.file}`, snapshot = parse(path)
    if (expected.has(path) || !object(snapshot) || snapshot.id !== id || snapshotHash(snapshot) !== item.hash) throw new Error('Backup contents do not match the export inventory')
    expected.add(path); counts[folder] = (counts[folder] ?? 0) + 1
  }
  if (files.size !== expected.size + 2 || metadata.ItemCounts.TotalPolicies !== expected.size || Object.entries(metadata.ItemCounts).some(([folder, count]) => folder !== 'TotalPolicies' && count !== (counts[folder] ?? 0))) throw new Error('Backup archive is incomplete or contains extra files')
  files.delete('tenuvault-manifest.json')
  return { tenantId: manifest.sourceTenantId.toLowerCase(), backupId: manifest.backupId, digest: createHash('sha256').update(raw).digest('hex'), files, count: expected.size }
}
export async function importArchive(store: LocalBlobStore, archive: ReviewedArchive): Promise<void> {
  const account = `tvlocal-${archive.tenantId}`, container = 'intune-backups', prefix = `${archive.backupId}/`
  await store.createContainer(account, container)
  if ((await store.list(account, container)).some(blob => blob.name.startsWith(prefix))) throw new Error('This backup already exists on this device')
  const written: string[] = []
  try {
    // Metadata is the completion marker and must be written last.
    for (const [name, content] of [...archive.files].sort(([a], [b]) => Number(a === 'metadata.json') - Number(b === 'metadata.json'))) {
      const data = name === 'metadata.json' ? Buffer.from(JSON.stringify({ ...JSON.parse(content.toString()), SourceTenantId: archive.tenantId, Import: { sha256: archive.digest, reviewedAt: new Date().toISOString(), provenance: 'User-reviewed ZIP; source identity is not cryptographically verified' } })) : content
      await store.put(account, container, prefix + name, data, 'application/json', true); written.push(prefix + name)
    }
  } catch (error) { for (const name of written) await store.delete(account, container, name).catch(() => undefined); throw error }
}
