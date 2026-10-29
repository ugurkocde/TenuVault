import { createHash } from 'node:crypto'
import type { KeyValueStore } from './secure-store'
export interface WriteRecord { key: string; tenant: string; method: string; path: string; at: string; state: 'uncertain' | 'complete' | 'reconciled'; objectId?: string; label?: string; /** Snapshot object ID this creation restores, when known. Binds a recreation to its source. */ sourceId?: string }
const memory = new Map<string, string>()
let store: KeyValueStore = { get: key => memory.get(key) ?? null, set: (key, value) => { memory.set(key, value) }, delete: key => { memory.delete(key) } }
export function setRestoreJournalStore(value: KeyValueStore): void { store = value }
export function writeKey(tenant: string, method: string, path: string, body: unknown): string {
  return createHash('sha256').update(JSON.stringify([tenant.toLowerCase(), method, path, body])).digest('hex')
}
export function writeRecords(): WriteRecord[] { return JSON.parse(store.get('restore.write-journal') ?? '[]') as WriteRecord[] }
export function saveWrite(record: WriteRecord): void {
  const entries = writeRecords().filter(entry => entry.key !== record.key)
  if (entries.length >= 1000) {
    const index = entries.findIndex(entry => entry.state === 'complete' || (entry.state === 'reconciled' && Date.parse(entry.at) < Date.now() - 60 * 60 * 1000))
    if (index < 0) throw new Error('Restore journal is full. Review write history in Settings before continuing; recent reconciliations stay protected for one hour.')
    entries.splice(index, 1)
  }
  entries.push(record)
  store.set('restore.write-journal', JSON.stringify(entries))
}
export function removeWrite(key: string): void { store.set('restore.write-journal', JSON.stringify(writeRecords().filter(entry => entry.key !== key))) }

let authorize: ((tenantId: string) => Promise<void>) | undefined
export function setRestoreJournalAuthorization(value: (tenantId: string) => Promise<void>): void { authorize = value }
export async function authorizeRestoreJournal(tenantId: string): Promise<void> {
  if (!authorize) throw new Error('Sign in with Intune access before opening restore history.')
  await authorize(tenantId)
}
