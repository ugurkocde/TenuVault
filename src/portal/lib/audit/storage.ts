import { auditId, projectEntry, projectItem } from './projection'
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

const DETAIL_PAGE_SIZE = 100
const MAX_DETAIL_PAGES = 1000
const AUDIT_CONTAINER = 'audit-logs'
const RETENTION_DAYS = 90 // Keep logs for 90 days
export const MAX_AUDIT_RANGE_DAYS = 90
export const AUDIT_READ_CONCURRENCY = 6
export class AuditRangeError extends Error {}
export class AuditContainerMissingError extends Error {
  constructor() { super('The audit container is missing. Rerun the Azure storage setup.') }
}
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
  fetch?: typeof fetch
  provisionContainer?: boolean
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

  private get fetch(): typeof fetch { return this.credentials.fetch ?? fetch }

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
    
    const check = await this.fetch(url, { method: 'HEAD', headers: this.getHeaders() })
    if (check.ok) return
    if (check.status !== 404) throw new Error(`Audit storage is unavailable (${check.status})`)
    const created = await this.fetch(url, { method: 'PUT', headers: this.getHeaders() })
    if (!created.ok && created.status !== 409) throw new Error(`Audit container could not be created (${created.status})`)
  }

  async testProducerAccess(tenantId: string): Promise<void> {
    const name = `producer-tests/${tenantId}/${crypto.randomUUID()}.json`
    const receipt = { tenantId, type: 'audit-access-test' }
    const auditUrl = this.blobUrl(name)
    const backupUrl = `${this.getBaseUrl()}/intune-backups/${blobPath(name)}`
    const request = (url: string, method: string, headers?: HeadersInit, body?: string) =>
      this.fetch(url, { method, headers: { ...this.getHeaders(), ...headers }, body, signal: AbortSignal.timeout(15000) })
    await this.putImmutable(name, receipt, existing => existing?.tenantId === tenantId)
    const read = await request(auditUrl, 'GET')
    if (!read.ok || (await read.json()).tenantId !== tenantId) throw new Error('Audit storage test could not be verified')
    const canary = JSON.stringify(receipt)
    const backup = await request(backupUrl, 'PUT', { 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*' }, canary)
    if (!backup.ok) throw new Error('Could not create the backup permission test blob')
    const probes = await Promise.all([
      request(auditUrl, 'PUT', { 'x-ms-blob-type': 'BlockBlob', 'If-Match': '*' }, JSON.stringify({ ...receipt, overwriteTest: true })),
      request(backupUrl, 'DELETE'),
    ])
    // Test audit deletion after overwrite, otherwise deletion could make the overwrite inconclusive.
    probes.push(await request(auditUrl, 'DELETE'))
    if (probes.some(result => result.ok)) throw new Error('The Backup Reader has excessive Azure Storage permissions. Remove grants that allow audit overwrite or blob deletion.')
    if (probes.some(result => result.status !== 403)) throw new Error('Azure Storage did not confirm that audit overwrite and blob deletion are denied.')
  }

  async writeLog(input: AuditLogEntry): Promise<void> {
    const entry = projectEntry(input)
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(input.id) || !Number.isFinite(Date.parse(entry.timestamp))) {
      throw new Error('Audit event requires a valid ID and timestamp')
    }
    queueEvent(this.credentials.storageAccountName, entry)
    await this.deliver(entry)
  }

  async deliver(input: AuditLogEntry): Promise<void> {
    const entry = projectEntry(input)
    if (this.credentials.provisionContainer !== false) await this.ensureContainerExists()
    await this.uploadLog(entry)
    acknowledgeEvent(this.credentials.storageAccountName, entry.id)
  }

  private detailPath(entry: AuditLogEntry, index: number): string {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(entry.id)) throw new Error('Invalid audit detail identifier')
    return `job-details/${entry.timestamp.slice(0, 10)}/${entry.id}/${index}.json`
  }

  private async putImmutable(name: string, data: unknown, matches: (existing: any) => boolean, metadata?: HeadersInit): Promise<void> {
    const url = this.blobUrl(name)
    const response = await this.fetch(url, {
      method: 'PUT',
      headers: { ...this.getHeaders(), 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*', ...metadata },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    })
    if ([403, 409, 412].includes(response.status)) {
      // An add-only identity may be denied on an existing blob. Verify without replacing it.
      const existing = await this.fetch(url, { headers: this.getHeaders(), signal: AbortSignal.timeout(15000) })
      if (existing.ok) {
        if (matches(await existing.json())) return
        throw new Error('An audit event with this ID already exists and could not be verified')
      }
    }
    if (response.status === 404 && response.headers.get('x-ms-error-code') === 'ContainerNotFound') throw new AuditContainerMissingError()
    if (!response.ok) throw new Error(`Failed to write audit log (${response.status}); the event is queued for retry`)
  }

  private async uploadLog(entry: AuditLogEntry): Promise<void> {
    const items = entry.job?.items
    let root = entry
    if (items && items.length > DETAIL_PAGE_SIZE) {
      const detailPages = Math.ceil(items.length / DETAIL_PAGE_SIZE)
      if (detailPages > MAX_DETAIL_PAGES) throw new Error('Audit job exceeds the detail page limit')
      for (let index = 0; index < detailPages; index++) {
        const page = { tenantId: entry.user.tenantId, items: items.slice(index * DETAIL_PAGE_SIZE, (index + 1) * DETAIL_PAGE_SIZE) }
        await this.putImmutable(this.detailPath(entry, index), page, existing => JSON.stringify(existing) === JSON.stringify(page))
      }
      root = { ...entry, job: { ...entry.job!, items: undefined, detailPages } }
    }
    const date = new Date(root.timestamp)
    const name = this.eventPath(root)
    const file: AuditLogFile = { date: date.toISOString().slice(0, 10), entries: [root], version: '2.0',
      metadata: { createdAt: root.timestamp, lastModified: root.timestamp, entryCount: 1 } }
    await this.putImmutable(name, file,
      existing => Array.isArray(existing?.entries) && existing.entries.length === 1
        && JSON.stringify(projectEntry(existing.entries[0])) === JSON.stringify(root),
      { 'x-ms-meta-audit_timestamp': root.timestamp, 'x-ms-meta-audit_entries': '1' })
  }

  private eventPath(entry: AuditLogEntry): string {
    return this.getLogFilePath(new Date(entry.timestamp)).replace('.json', `-event-${entry.id}.json`)
  }

  private async eventWasSaved(input: AuditLogEntry): Promise<boolean> {
    const entry = projectEntry(input)
    const response = await this.fetch(this.blobUrl(this.eventPath(entry)), {
      headers: this.getHeaders(), signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) return false
    const file = await response.json()
    return Array.isArray(file?.entries) && file.entries.length === 1
      && JSON.stringify(projectEntry(file.entries[0])) === JSON.stringify(entry)
  }

  pendingCount(tenantId?: string): number {
    return pendingEvents(this.credentials.storageAccountName)
      .filter(entry => !tenantId || !entry.user.tenantId || entry.user.tenantId.toLowerCase() === tenantId.toLowerCase()).length
  }

  async retryPending(tenantId?: string): Promise<number> {
    const entries = pendingEvents(this.credentials.storageAccountName)
      .filter(entry => !tenantId || !entry.user.tenantId || entry.user.tenantId.toLowerCase() === tenantId.toLowerCase()).slice(0, 100)
    const saved = new Set<string>()
    let writable = false
    try {
      if (entries.some(entry => entry.job?.producer !== 'backup-reader')) {
        await this.ensureContainerExists()
        writable = true
      }
    } catch { /* A granted read can still confirm an earlier delivery. */ }
    for (const entry of entries) {
      try {
        if (entry.job?.producer === 'backup-reader') {
          if (await this.eventWasSaved(entry)) saved.add(entry.id)
        } else if (writable) {
          await this.uploadLog(projectEntry(entry))
          saved.add(entry.id)
        }
      } catch { /* Retry remaining events independently. */ }
    }
    acknowledgeEvents(this.credentials.storageAccountName, saved)
    return this.pendingCount(tenantId)
  }

  private async withDetails(entry: AuditLogEntry): Promise<AuditLogEntry> {
    const count = entry.job?.detailPages
    if (!count) return entry
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_DETAIL_PAGES) throw new Error('Invalid audit detail page count')
    const pages = await mapLimit(Array.from({ length: count }, (_, index) => index), AUDIT_READ_CONCURRENCY, index =>
      limitRead(this.credentials.storageAccountName, async () => {
        const response = await this.fetch(this.blobUrl(this.detailPath(entry, index)), { headers: this.getHeaders() })
        if (!response.ok) throw new Error(`Audit job detail could not be read (${response.status})`)
        const page = await response.json()
        if (page.tenantId !== entry.user.tenantId || !Array.isArray(page.items) || page.items.length > DETAIL_PAGE_SIZE) throw new Error('Invalid audit detail page')
        return page.items.map(projectItem)
      }))
    return { ...entry, job: { ...entry.job!, items: pages.flat() } }
  }

  async queryLogs(filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 100
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new AuditRangeError('Choose a limit from 1 to 1000 and a non-negative offset.')
    }
    const entries = await this.query(filter, offset + limit)
    return mapLimit(entries.slice(offset, offset + limit), AUDIT_READ_CONCURRENCY, entry => this.withDetails(entry))
  }

  /** Complete matching history for exports and aggregates, independent of UI pagination. */
  async queryAllLogs(filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    return mapLimit(await this.query(filter), AUDIT_READ_CONCURRENCY, entry => this.withDetails(entry))
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
      const response = await this.fetch(this.blobUrl(blob.name), { headers: this.getHeaders() })
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
      const reference = auditId(filter.searchQuery)?.toLowerCase()
      filteredEntries = filteredEntries.filter(e => 
        e.action.toLowerCase().includes(query) ||
        e.user.email.toLowerCase().includes(query) ||
        e.user.name.toLowerCase().includes(query) ||
        e.resource.name.toLowerCase().includes(query) ||
        e.resource.id.toLowerCase().includes(query) || e.resource.id === reference ||
        (e.context?.correlationId ?? '').toLowerCase().includes(query) ||
        JSON.stringify(e.details ?? {}).toLowerCase().includes(query) ||
        JSON.stringify(e.job ?? {}).toLowerCase().includes(query)
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
    const allEntries = await this.query(filter)
    
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
      const data = await file.json().catch(() => null)
      const entries = data?.entries as AuditLogEntry[] | undefined
      const owned = /^(?:job-details|producer-tests)\//.test(decodeXml(name)) ? typeof data?.tenantId === 'string' && data.tenantId.toLowerCase() === tenant : Array.isArray(entries) && entries.length > 0 && entries.every((entry) => typeof entry?.user?.tenantId === 'string' && entry.user.tenantId.toLowerCase() === tenant)
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
