import { acknowledgeEvent, acknowledgeEvents, pendingEvents, queueEvent } from './outbox'
import { BlobListError, decodeXml, listBlobPages } from '../storage/list'
import { mapLimit } from '../../../shared/map-limit'
import { MetadataCache } from '../storage/metadata-cache'
import { blobPath } from '../../../shared/security'
import { entriesForTenant } from './export'
import { auditDateFilter, defaultAuditDateRange } from './date-range'
import { 
  AuditLogEntry, 
  AuditLogFilter, 
  AuditLogStats,
  AuditEventType,
  AuditSeverity,
  AuditResult 
} from './types'

const AUDIT_CONTAINER = 'audit-logs'
const RETENTION_DAYS = 90 // Keep logs for 90 days
export const MAX_AUDIT_RANGE_DAYS = 90
export const AUDIT_READ_CONCURRENCY = 6
export class AuditRangeError extends Error {}
interface AuditBlob { name: string; dayPath: string; timestamp: number | null; version: string }
const readCaches = new WeakMap<typeof fetch, MetadataCache<AuditLogEntry[]>>()

/** Listings, stats and exports share one budget for each storage account. */
const readLimiters = new Map<string, { active: number; waiting: Array<() => void> }>()
async function limitRead<T>(account: string, run: () => Promise<T>): Promise<T> {
  const key = account.toLowerCase()
  let limiter = readLimiters.get(key)
  if (!limiter) { limiter = { active: 0, waiting: [] }; readLimiters.set(key, limiter) }
  if (limiter.active >= AUDIT_READ_CONCURRENCY) await new Promise<void>(resolve => limiter.waiting.push(resolve))
  else limiter.active++
  try {
    return await run()
  } finally {
    const next = limiter.waiting.shift()
    if (next) next()
    else if (--limiter.active === 0) readLimiters.delete(key)
  }
}

interface StorageCredentials {
  storageAccountName: string
  accessToken: string
}

interface AuditLogFile {
  date: string
  entries: AuditLogEntry[]
  version: string
  metadata: {
    createdAt: string
    lastModified: string
    entryCount: number
    compressed?: boolean
  }
}

export class AuditStorageService {
  private credentials: StorageCredentials

  constructor(credentials: StorageCredentials) {
    this.credentials = credentials
  }

  private getBaseUrl(): string {
    return `https://${this.credentials.storageAccountName}.blob.core.windows.net`
  }

  private getHeaders(): HeadersInit {
    return {
      'x-ms-version': '2021-12-02',
      'x-ms-date': new Date().toUTCString(),
      'Authorization': `Bearer ${this.credentials.accessToken}`,
      'Content-Type': 'application/json',
    }
  }

  /**
   * URL of a listing-derived blob, refused unless it resolves inside the audit container.
   * blobPath rejects dot segments first, which URL parsing would otherwise resolve to another blob.
   */
  private blobUrl(name: string): string {
    const url = new URL(`${this.getBaseUrl()}/${AUDIT_CONTAINER}/${blobPath(name)}`)
    if (!url.pathname.startsWith(`/${AUDIT_CONTAINER}/`) || url.pathname.length === AUDIT_CONTAINER.length + 2) {
      throw new Error('Audit blob name resolves outside the audit container')
    }
    return url.href
  }

  private getLogFilePath(date: Date): string {
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const day = String(date.getUTCDate()).padStart(2, '0')
    return `${year}/${month}/${day}/audit-log-${year}${month}${day}.json`
  }

  private getDateRange(startDate: Date, endDate: Date): Date[] {
    const dates: Date[] = []
    const currentDate = new Date(startDate)
    const lastDate = new Date(endDate)
    currentDate.setUTCHours(0, 0, 0, 0)
    lastDate.setUTCHours(0, 0, 0, 0)
    // Older writers grouped events by local day, which can neighbor their UTC day.
    currentDate.setUTCDate(currentDate.getUTCDate() - 1)
    lastDate.setUTCDate(lastDate.getUTCDate() + 1)

    while (currentDate <= lastDate) {
      dates.push(new Date(currentDate))
      currentDate.setUTCDate(currentDate.getUTCDate() + 1)
    }
    
    return dates
  }

  async ensureContainerExists(): Promise<void> {
    const url = `${this.getBaseUrl()}/${AUDIT_CONTAINER}?restype=container`
    
    console.log('[AUDIT-STORAGE] Checking if audit-logs container exists...')
    
    try {
      // Check if container exists
      const checkResponse = await fetch(url, {
        method: 'HEAD',
        headers: this.getHeaders(),
      })
      
      console.log('[AUDIT-STORAGE] Container check response:', checkResponse.status)
      
      if (checkResponse.status === 404) {
        console.log('[AUDIT-STORAGE] Container does not exist, attempting to create...')
        
        // Create container if it doesn't exist
        const createResponse = await fetch(url, {
          method: 'PUT',
          headers: this.getHeaders(),
        })
        
        console.log('[AUDIT-STORAGE] Container creation response:', createResponse.status)
        
        if (!createResponse.ok && createResponse.status !== 409) {
          const errorText = await createResponse.text()
          console.error('[AUDIT-STORAGE] Failed to create container:', errorText)
          throw new Error(`Failed to create audit container: ${createResponse.status} - ${errorText}`)
        }
        
        console.log('[AUDIT-STORAGE] Successfully created audit-logs container')
      } else if (checkResponse.ok || checkResponse.status === 200) {
        console.log('[AUDIT-STORAGE] Container already exists')
      } else {
        throw new Error(`Audit storage is unavailable (${checkResponse.status})`)
      }
    } catch (error) {
      console.error('[AUDIT-STORAGE] Error ensuring audit container exists:', error)
      throw error
    }
  }

  async writeLog(entry: AuditLogEntry): Promise<void> {
    if (!entry.id || !/^[a-zA-Z0-9-]{1,128}$/.test(entry.id) || !Number.isFinite(Date.parse(entry.timestamp))) {
      throw new Error('Audit event requires a valid ID and timestamp')
    }
    queueEvent(this.credentials.storageAccountName, entry)
    await this.ensureContainerExists()
    await this.uploadLog(entry)
    acknowledgeEvent(this.credentials.storageAccountName, entry.id)
  }

  private async uploadLog(entry: AuditLogEntry): Promise<void> {
    const date = new Date(entry.timestamp)
    // The daily prefix keeps legacy files and immutable events queryable together.
    const path = this.getLogFilePath(date).replace('.json', `-event-${entry.id}.json`)
    const url = `${this.getBaseUrl()}/${AUDIT_CONTAINER}/${path}`
    const file: AuditLogFile = { date: date.toISOString().slice(0, 10), entries: [entry], version: '2.0',
      metadata: { createdAt: entry.timestamp, lastModified: entry.timestamp, entryCount: 1 } }
    const response = await fetch(url, { method: 'PUT', headers: { ...this.getHeaders(), 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*', 'x-ms-meta-audit_timestamp': entry.timestamp, 'x-ms-meta-audit_entries': '1' }, body: JSON.stringify(file) })
    if (response.status === 412) {
      // A retry after a lost response must not duplicate the event or replace a
      // different event that accidentally reused its ID.
      const existing = await fetch(url, { headers: this.getHeaders() })
      if (existing.ok && JSON.stringify((await existing.json()).entries) === JSON.stringify([entry])) {
        return
      }
      throw new Error('An audit event with this ID already exists and could not be verified')
    }
    if (!response.ok) throw new Error(`Failed to write audit log (${response.status}); the event is queued for retry`)
  }

  pendingCount(): number { return pendingEvents(this.credentials.storageAccountName).length }

  async retryPending(): Promise<number> {
    // Bound network work per refresh and acknowledge once, preserving newly queued events.
    const entries = pendingEvents(this.credentials.storageAccountName).slice(0, 100)
    const saved = new Set<string>()
    try {
      if (entries.length) await this.ensureContainerExists()
      for (const entry of entries) {
        try { await this.uploadLog(entry); saved.add(entry.id) } catch { break }
      }
    } catch { /* Keep the queue visible when container access fails. */ }
    finally { acknowledgeEvents(this.credentials.storageAccountName, saved) }
    return this.pendingCount()
  }

  async queryLogs(filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 100
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new AuditRangeError('Choose a limit from 1 to 1000 and a non-negative offset.')
    }
    const entries = await this.query(filter, offset + limit)
    return entries.slice(offset, offset + limit)
  }

  /** Complete matching history for exports and aggregates, independent of UI pagination. */
  async queryAllLogs(filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    return this.query(filter)
  }

  private async query(filter: AuditLogFilter, needed?: number): Promise<AuditLogEntry[]> {
    const defaultDates = auditDateFilter(defaultAuditDateRange())
    const startDate = filter.startDate || new Date(defaultDates.startDate!)
    const endDate = filter.endDate || new Date(defaultDates.endDate!)
    const startTime = startDate.getTime()
    const endTime = endDate.getTime()
    // Two hours allow full picker days across daylight saving transitions.
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime || endTime - startTime > MAX_AUDIT_RANGE_DAYS * 86400_000 + 2 * 3600_000) {
      throw new AuditRangeError(`Choose a valid audit date range of at most ${MAX_AUDIT_RANGE_DAYS} days. Export longer history in separate ranges.`)
    }
    const dates = this.getDateRange(startDate, endDate)
    const listings = await mapLimit(dates, AUDIT_READ_CONCURRENCY, async (date): Promise<AuditBlob[]> => limitRead(this.credentials.storageAccountName, async () => {
      const dayPath = this.getLogFilePath(date)
      const listUrl = `${this.getBaseUrl()}/${AUDIT_CONTAINER}?restype=container&comp=list&include=metadata&prefix=${dayPath.replace('.json', '')}`
      try {
        const text = await listBlobPages(listUrl, this.credentials.accessToken)
        return [...text.matchAll(/<Blob>[\s\S]*?<\/Blob>/g)].flatMap((match) => {
          const name = decodeXml(match[0].match(/<Name>([^<]+)<\/Name>/)?.[1] ?? '')
          if (!name) return []
          try { this.blobUrl(name) } catch { return [] }
          const timestamp = Date.parse(decodeXml(match[0].match(/<audit_timestamp>([^<]+)<\/audit_timestamp>/)?.[1] ?? ''))
          const single = /<audit_entries>1<\/audit_entries>/.test(match[0]) && name.includes('-event-')
          return [{ name, dayPath, timestamp: single && Number.isFinite(timestamp) ? timestamp : null,
            version: match[0].match(/<Etag>([^<]+)<\/Etag>/)?.[1] ?? '' }]
        })
      } catch (error) {
        if (error instanceof BlobListError && error.status === 404 && error.completedPages === 0) return []
        throw error
      }
    }))
    const blobs = [...new Map(listings.flat().map((blob) => [blob.name, blob])).values()]
    const allEntries = new Map<string, AuditLogEntry>()
    const add = (blob: AuditBlob, entries: AuditLogEntry[]) => {
      for (const entry of entries) {
        // An upgrade retry under both local and UTC days still counts once.
        if (!allEntries.has(entry.id) || this.getLogFilePath(new Date(entry.timestamp)) === blob.dayPath) allEntries.set(entry.id, entry)
      }
    }
    const read = async (blob: AuditBlob) => add(blob, await this.readLogBlob(blob))
    // Older daily files do not expose event timestamps. Read them with a cap and cache
    // their contents by ETag rather than guessing order from upload time or random IDs.
    await mapLimit(blobs.filter((blob) => blob.timestamp === null), AUDIT_READ_CONCURRENCY, read)
    const ordered = blobs.filter((blob) => blob.timestamp !== null && blob.timestamp >= startTime && blob.timestamp <= endTime)
      .sort((a, b) => b.timestamp! - a.timestamp! || this.eventId(a).localeCompare(this.eventId(b)))
    const paginated = needed !== undefined && (!filter.sortBy || filter.sortBy === 'timestamp') && (!filter.sortOrder || filter.sortOrder === 'desc')
    if (!paginated) {
      await mapLimit(ordered, AUDIT_READ_CONCURRENCY, read)
      return this.filterEntries([...allEntries.values()], filter, startTime, endTime)
    }
    let filtered = this.filterEntries([...allEntries.values()], filter, startTime, endTime)
    for (let index = 0; index < ordered.length;) {
      const cutoff = filtered[needed! - 1]
      if (paginated && cutoff && (ordered[index]!.timestamp! < Date.parse(cutoff.timestamp) || (ordered[index]!.timestamp === Date.parse(cutoff.timestamp) && this.eventId(ordered[index]!).localeCompare(cutoff.id) > 0))) break
      const count = Math.max(1, Math.min(AUDIT_READ_CONCURRENCY, needed! - filtered.length))
      await mapLimit(ordered.slice(index, index + count), AUDIT_READ_CONCURRENCY, read)
      index += count
      filtered = this.filterEntries([...allEntries.values()], filter, startTime, endTime)
    }
    return filtered
  }

  private eventId(blob: AuditBlob): string {
    return blob.name.slice(blob.name.indexOf('-event-') + '-event-'.length, -'.json'.length)
  }

  private async readLogBlob(blob: AuditBlob): Promise<AuditLogEntry[]> {
    let cache = readCaches.get(fetch)
    if (!cache) { cache = new MetadataCache(() => true); readCaches.set(fetch, cache) }
    const key = JSON.stringify([this.credentials.storageAccountName.toLowerCase(), blob.name])
    const load = () => limitRead(this.credentials.storageAccountName, async () => {
      const response = await fetch(this.blobUrl(blob.name), { headers: this.getHeaders() })
      if (!response.ok) throw new Error(`Audit history is unavailable: an event file could not be read (${response.status})`)
      const file: AuditLogFile = await response.json()
      if (!Array.isArray(file.entries) || (blob.timestamp !== null && (file.entries.length !== 1 || Date.parse(file.entries[0]!.timestamp) !== blob.timestamp || file.entries[0]!.id !== this.eventId(blob)))) {
        throw new Error('Audit history is unavailable: an event file does not match its listing metadata')
      }
      return file.entries
    })
    return blob.version ? cache.read(key, blob.version, load) : load()
  }

  private filterEntries(entries: AuditLogEntry[], filter: AuditLogFilter, startTime: number, endTime: number): AuditLogEntry[] {
    // Apply filters
    let filteredEntries = entries.filter(entry => {
      const timestamp = new Date(entry.timestamp).getTime()
      return timestamp >= startTime && timestamp <= endTime
    })
    if (filter.tenantId) filteredEntries = entriesForTenant(filteredEntries, filter.tenantId)
    
    if (filter.eventTypes?.length) {
      filteredEntries = filteredEntries.filter(e => filter.eventTypes!.includes(e.eventType))
    }
    
    if (filter.severities?.length) {
      filteredEntries = filteredEntries.filter(e => filter.severities!.includes(e.severity))
    }
    
    if (filter.userIds?.length) {
      filteredEntries = filteredEntries.filter(e => filter.userIds!.includes(e.user.id))
    }
    
    if (filter.userEmails?.length) {
      filteredEntries = filteredEntries.filter(e => filter.userEmails!.includes(e.user.email))
    }
    
    if (filter.resourceTypes?.length) {
      filteredEntries = filteredEntries.filter(e => filter.resourceTypes!.includes(e.resource.type))
    }
    
    if (filter.resourceIds?.length) {
      filteredEntries = filteredEntries.filter(e => filter.resourceIds!.includes(e.resource.id))
    }
    
    if (filter.results?.length) {
      filteredEntries = filteredEntries.filter(e => filter.results!.includes(e.result))
    }
    
    if (filter.ipAddress) {
      filteredEntries = filteredEntries.filter(e => e.context.ipAddress === filter.ipAddress)
    }
    
    if (filter.tags?.length) {
      filteredEntries = filteredEntries.filter(e => 
        e.tags?.some(tag => filter.tags!.includes(tag))
      )
    }
    
    if (filter.searchQuery) {
      const query = filter.searchQuery.toLowerCase()
      filteredEntries = filteredEntries.filter(e => 
        e.action.toLowerCase().includes(query) ||
        e.user.email.toLowerCase().includes(query) ||
        e.user.name.toLowerCase().includes(query) ||
        e.resource.name.toLowerCase().includes(query) ||
        JSON.stringify(e.details).toLowerCase().includes(query)
      )
    }
    
    // Sort
    const sortBy = filter.sortBy || 'timestamp'
    const sortOrder = filter.sortOrder || 'desc'
    
    filteredEntries.sort((a, b) => {
      let aVal: any, bVal: any
      
      switch (sortBy) {
        case 'timestamp':
          aVal = new Date(a.timestamp).getTime()
          bVal = new Date(b.timestamp).getTime()
          break
        case 'eventType':
          aVal = a.eventType
          bVal = b.eventType
          break
        case 'severity':
          aVal = a.severity
          bVal = b.severity
          break
        case 'user':
          aVal = a.user.email
          bVal = b.user.email
          break
        case 'result':
          aVal = a.result
          bVal = b.result
          break
        default:
          aVal = a.timestamp
          bVal = b.timestamp
      }
      
      if (sortOrder === 'asc') {
        return aVal > bVal ? 1 : aVal < bVal ? -1 : a.id.localeCompare(b.id)
      } else {
        return aVal < bVal ? 1 : aVal > bVal ? -1 : a.id.localeCompare(b.id)
      }
    })
    
    return filteredEntries
  }

  async getStats(filter: AuditLogFilter): Promise<AuditLogStats> {
    const allEntries = await this.queryAllLogs(filter)
    
    const stats: AuditLogStats = {
      totalEvents: allEntries.length,
      eventsByType: {} as Record<AuditEventType, number>,
      eventsBySeverity: {} as Record<AuditSeverity, number>,
      eventsByResult: {} as Record<AuditResult, number>,
      eventsByHour: [],
      topUsers: [],
      topResources: [],
      recentFailures: [],
      securityEvents: [],
    }
    
    // Count events by type
    for (const eventType of Object.values(AuditEventType)) {
      stats.eventsByType[eventType] = allEntries.filter(e => e.eventType === eventType).length
    }
    
    // Count events by severity
    for (const severity of Object.values(AuditSeverity)) {
      stats.eventsBySeverity[severity] = allEntries.filter(e => e.severity === severity).length
    }
    
    // Count events by result
    for (const result of Object.values(AuditResult)) {
      stats.eventsByResult[result] = allEntries.filter(e => e.result === result).length
    }
    
    // Events by hour (last 24 hours)
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const recentEntries = allEntries.filter(e => new Date(e.timestamp) > last24Hours)
    const hourCounts = new Map<string, number>()
    
    recentEntries.forEach(entry => {
      const hour = new Date(entry.timestamp).toISOString().substring(0, 13)
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1)
    })
    
    stats.eventsByHour = Array.from(hourCounts.entries())
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => a.hour.localeCompare(b.hour))
    
    // Top users
    const userCounts = new Map<string, { user: any, count: number }>()
    allEntries.forEach(entry => {
      const key = entry.user.email
      if (userCounts.has(key)) {
        userCounts.get(key)!.count++
      } else {
        userCounts.set(key, { user: entry.user, count: 1 })
      }
    })
    
    stats.topUsers = Array.from(userCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
    
    // Top resources
    const resourceCounts = new Map<string, { resource: any, count: number }>()
    allEntries.forEach(entry => {
      const key = `${entry.resource.type}:${entry.resource.id}`
      if (resourceCounts.has(key)) {
        resourceCounts.get(key)!.count++
      } else {
        resourceCounts.set(key, { resource: entry.resource, count: 1 })
      }
    })
    
    stats.topResources = Array.from(resourceCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
    
    // Recent failures
    stats.recentFailures = allEntries
      .filter(e => e.result === AuditResult.FAILURE)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 10)
    
    // Security events
    stats.securityEvents = allEntries
      .filter(e => e.eventType.startsWith('SECURITY_') || e.severity === AuditSeverity.CRITICAL)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 10)
    
    return stats
  }

  /**
   * Deletes this tenant's audit files older than the retention period. A file is deleted only
   * when every entry in it names this tenant; files with entries of another tenant or without
   * a tenant stay. Reads every listing page, and any failed list, read or delete throws so the
   * caller never reports a cleanup that did not happen.
   */
  async cleanupOldLogs(tenantId: string, retentionDays = RETENTION_DAYS): Promise<{ deleted: number; kept: number }> {
    const tenant = tenantId.toLowerCase()
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    let text: string
    try {
      text = await listBlobPages(`${this.getBaseUrl()}/${AUDIT_CONTAINER}?restype=container&comp=list`, this.credentials.accessToken)
    } catch (error) {
      // No audit container yet: nothing to clean.
      if (error instanceof BlobListError && error.status === 404 && error.completedPages === 0) return { deleted: 0, kept: 0 }
      throw error
    }
    let deleted = 0
    let kept = 0
    for (const blobMatch of text.matchAll(/<Blob>[\s\S]*?<\/Blob>/g)) {
      const blobXml = blobMatch[0]
      const name = blobXml.match(/<Name>([^<]+)<\/Name>/)?.[1]
      const lastModified = blobXml.match(/<Last-Modified>([^<]+)<\/Last-Modified>/)?.[1]
      if (!name || !lastModified || !(new Date(lastModified) < cutoffDate)) continue
      let blobUrl: string
      try { blobUrl = this.blobUrl(decodeXml(name)) } catch { continue }
      const file = await fetch(blobUrl, { headers: this.getHeaders() })
      if (file.status === 404) continue
      if (!file.ok) throw new Error(`An audit file could not be read (${file.status}); nothing more was deleted.`)
      const entries = ((await file.json().catch(() => null)) as Partial<AuditLogFile> | null)?.entries
      const owned = Array.isArray(entries) && entries.length > 0 && entries.every((entry) => typeof entry?.user?.tenantId === 'string' && entry.user.tenantId.toLowerCase() === tenant)
      if (!owned) {
        kept++
        continue
      }
      const response = await fetch(blobUrl, { method: 'DELETE', headers: this.getHeaders() })
      if (!response.ok && response.status !== 404) throw new Error(`An audit file could not be deleted (${response.status}); ${deleted} older file${deleted === 1 ? ' was' : 's were'} deleted before it.`)
      deleted++
    }
    return { deleted, kept }
  }
}
