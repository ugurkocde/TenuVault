import { randomUUID } from 'node:crypto'
import { assertStorageAccountName } from '../../shared/storage-account'
import { isGuid } from '../../shared/security'
import type { KeyValueStore } from '../storage/secure-store'
import type { BackupRunIdentity } from '../backup/run-history'
import { AuditEventType, AuditResult, AuditSeverity, type AuditJob, type AuditJobItem, type AuditLogEntry, type AuditUser, type CreateAuditLogInput } from '~/lib/audit/types'
import { projectEntry, projectItem } from '~/lib/audit/projection'
import { pendingEvents, queueEvent, queuedAccounts } from '~/lib/audit/outbox'
import { AuditStorageService } from '~/lib/audit/storage'

export interface AuditBinding {
  tenantId: string
  storageAccountName: string
  user: AuditUser
}

interface AuditSinkOptions {
  store?: KeyValueStore
  bind: (tenant: string) => AuditBinding | undefined
  transport: (account: string, entry: AuditLogEntry) => Promise<AuditStorageService>
  onDelivery?: (account: string, entry: AuditLogEntry, error?: unknown) => void
}

export interface RestoreCorrelation {
  actor: string
  source: string
  destinations: string[]
  operationId: string
  at: number
}

interface Checkpoint {
  binding: AuditBinding
  entry: AuditLogEntry
  finished?: boolean
  /** Legacy flag for checkpoints whose key was also their completion ID. */
  completion?: boolean
  completionId?: string
  ready?: boolean
  correlation?: RestoreCorrelation
}

interface RestoreAuditOptions {
  eventId?: string
  correlation?: RestoreCorrelation
}

interface AuditProgress {
  correlate(operationId: string): void
  started(index: number): void
  item(index: number, item: AuditJobItem, checkpoint?: boolean): void
  ready(index: number, item: AuditJobItem): void
  refuse(index: number, item: AuditJobItem): void
  finish(uncertain?: boolean): void
}

interface RestoreReceipt {
  at: number
  ready?: boolean
  correlation?: RestoreCorrelation
}

const JOURNAL = 'audit.restore-jobs'
const RECEIPTS = 'audit.restore-receipts'
const RESTORE_CHECKPOINT_ITEMS = 25
const warning = () => console.warn('[audit] Audit delivery requires attention')
const isBackupCheckpoint = (entry: AuditLogEntry) =>
  entry.eventType === AuditEventType.BACKUP_COMPLETED || entry.eventType === AuditEventType.BACKUP_FAILED ||
  entry.eventType === AuditEventType.BACKUP_CANCELLED
const isStandaloneTerminal = (entry: AuditLogEntry) => isBackupCheckpoint(entry) ||
  (entry.eventType === AuditEventType.RESTORE_FAILED && entry.job?.stage === 'terminal' &&
    entry.job.reason === 'RESTORE_PREPARATION_FAILED')

/**
 * Main process API for jobs, approval stages and policy events. Obtain the destination binding
 * before executing, keep the operation ID across continuations, and use a fresh run ID per attempt.
 * Return the operation result independently of audit delivery.
 */
export class AuditSink {
  private checkpoints: Record<string, Checkpoint>
  private receipts: Record<string, RestoreReceipt>
  private readonly interruptedBackups: Set<string>
  private retrying = false
  private readonly retryOffsets = new Map<string, number>()

  constructor(private readonly options: AuditSinkOptions) {
    this.checkpoints = this.load(JOURNAL, (value): value is Checkpoint => {
      const checkpoint = value as Partial<Checkpoint> | null
      return typeof checkpoint?.binding?.storageAccountName === 'string' && typeof checkpoint.entry?.id === 'string' &&
        !!checkpoint.entry.job && !!checkpoint.entry.user
    })
    this.receipts = this.load(RECEIPTS, (value): value is RestoreReceipt => typeof (value as RestoreReceipt | null)?.at === 'number')
    this.interruptedBackups = new Set(Object.entries(this.checkpoints)
      .filter(([, checkpoint]) => !checkpoint.finished && isBackupCheckpoint(checkpoint.entry)).map(([id]) => id))
  }

  private load<T>(key: string, isRecord: (value: unknown) => value is T): Record<string, T> {
    let raw: string | null | undefined
    try {
      raw = this.options.store?.get(key)
      const value = JSON.parse(raw ?? '{}')
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(isRecord)) return value
      throw new Error('Invalid audit checkpoint data')
    } catch {
      warning()
      if (raw != null) {
        try {
          this.options.store?.set(`${key}.quarantine`, raw)
          this.options.store?.delete(key)
        } catch { warning() }
      }
      return {}
    }
  }

  bind(tenant: string): AuditBinding | undefined {
    const binding = this.options.bind(tenant)
    if (binding) assertStorageAccountName(binding.storageAccountName)
    return binding
  }

  private save(next: Record<string, Checkpoint>): void {
    this.options.store?.set(JOURNAL, JSON.stringify(next))
    this.checkpoints = next
  }

  private entry(binding: AuditBinding, input: CreateAuditLogInput, stamp?: { id: string; timestamp: string }): AuditLogEntry {
    return projectEntry({
      ...input, id: stamp?.id ?? randomUUID(), timestamp: stamp?.timestamp ?? new Date().toISOString(),
      result: input.result ?? AuditResult.SUCCESS, severity: input.severity ?? AuditSeverity.INFO,
      user: { ...binding.user, tenantId: binding.tenantId.toLowerCase() },
      context: { ipAddress: 'unknown', userAgent: 'TenuVault Desktop', correlationId: input.job?.operationId },
    })
  }

  async record(binding: AuditBinding, input: CreateAuditLogInput, stamp?: { id: string; timestamp: string }): Promise<void> {
    const entry = this.entry(binding, input, stamp)
    const checkpoint = { binding: { ...binding, user: entry.user }, entry }
    if (isBackupCheckpoint(entry) && entry.job?.status === 'uncertain' && entry.job.reason === 'WRITE_UNCONFIRMED') {
      // Let the backup audit recovery read the manifest before this event becomes immutable.
      this.save({ ...this.checkpoints, [entry.id]: checkpoint })
      this.interruptedBackups.add(entry.id)
      return
    }
    if (this.checkpoints[entry.id]) this.finishCheckpoint(checkpoint)
    else {
      try { queueEvent(binding.storageAccountName, entry) }
      catch (error) {
        if (!isStandaloneTerminal(entry)) throw error
        this.finishCheckpoint(checkpoint)
      }
    }
    await this.deliver(binding.storageAccountName, entry)
  }

  private async deliver(account: string, entry: AuditLogEntry): Promise<void> {
    try {
      const storage = await this.options.transport(account, entry)
      await storage.deliver(entry)
    } catch (error) {
      this.options.onDelivery?.(account, entry, error)
      throw error
    }
    this.options.onDelivery?.(account, entry)
  }

  restoreCorrelation(runId: string): RestoreCorrelation | undefined {
    return Object.values(this.checkpoints).find(checkpoint => checkpoint.entry.job?.runId === runId && checkpoint.correlation)?.correlation
      ?? this.receipts[`restore:${runId}`]?.correlation
  }

  begin(binding: AuditBinding, input: CreateAuditLogInput & { job: AuditJob }): AuditProgress
  begin(binding: AuditBinding, input: CreateAuditLogInput & { job: AuditJob }, options: RestoreAuditOptions): AuditProgress | undefined
  begin(binding: AuditBinding, input: CreateAuditLogInput & { job: AuditJob }, options: RestoreAuditOptions = {}): AuditProgress | undefined {
    let completionId = options.eventId
    // Each execution gets its own audit event, even if it resumes a previously recorded approval.
    const previous = completionId && (this.receipts[completionId] ||
      Object.values(this.checkpoints).some(checkpoint => checkpoint.completionId === completionId || checkpoint.entry.id === completionId))
    const id = previous ? randomUUID() : completionId
    const entry = this.entry(binding, input, id ? { id, timestamp: new Date().toISOString() } : undefined)
    if (previous) entry.job!.runId = entry.id
    const bound = { ...binding, user: entry.user }
    let finished = false
    let ready = false
    let batchEnd = 0
    const checkpoint = (snapshot = entry): Checkpoint => ({
      binding: bound, entry: snapshot, ready, completionId, correlation: options.correlation,
    })
    const persist = (snapshot = entry) => {
      this.save({ ...this.checkpoints, [entry.id]: checkpoint(snapshot) })
    }
    try { persist() } catch { warning() }
    const persistBatch = (from: number, end: number) => {
      const items = entry.job!.items!.map((item, index): AuditJobItem => index >= from && index < end
        ? { ...item, outcome: 'uncertain', reason: 'PROCESS_INTERRUPTED' } : item)
      persist({ ...entry, job: { ...entry.job!, items } })
    }
    const storeItem = (index: number, item: AuditJobItem, checkpoint = false) => {
      if (finished) return
      entry.job!.items![index] = projectItem(item)
      try {
        if (index >= batchEnd) persist()
        else if (checkpoint) persistBatch(index + 1, batchEnd)
      } catch { warning() }
    }
    return {
      correlate: operationId => {
        entry.job!.operationId = operationId
        entry.context.correlationId = operationId
        try { persist() } catch { warning() }
      },
      started: index => {
        const items = entry.job!.items!
        if (items.length > RESTORE_CHECKPOINT_ITEMS && index >= batchEnd) {
          const end = index + RESTORE_CHECKPOINT_ITEMS
          // Write ahead for this window so a restart never treats a possible write as unattempted.
          try { persistBatch(index, end); batchEnd = end } catch { warning() }
        }
        storeItem(index, { ...items[index]!, outcome: 'uncertain', reason: 'PROCESS_INTERRUPTED' })
      },
      item: storeItem,
      ready: (index, item) => {
        entry.job!.items![index] = projectItem(item)
        ready = true
        try { persist() } catch { warning() }
      },
      refuse: (index, item) => {
        if (!completionId || finished) return
        const { [entry.id]: _completion, ...remaining } = this.checkpoints
        const attemptId = randomUUID()
        entry.id = entry.job!.runId = attemptId
        entry.job!.stage = 'approval-attempt'
        entry.job!.items![index] = projectItem(item)
        completionId = undefined
        try { this.save({ ...remaining, [attemptId]: { binding: bound, entry } }) } catch { warning() }
      },
      finish: (uncertain = false) => {
        if (finished) return
        finished = true
        if (!completionId) entry.timestamp = new Date().toISOString()
        this.finalize(entry, uncertain)
        try {
          this.finishCheckpoint(checkpoint())
          void this.deliver(bound.storageAccountName, entry).catch(warning)
        } catch { warning() }
      },
    }
  }

  private finalize(entry: AuditLogEntry, interrupted: boolean): void {
    const job = entry.job!
    const counts: AuditJob['counts'] = {}
    for (const item of job.items ?? []) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1
    const writes = (counts.created ?? 0) + (counts.updated ?? 0)
    const failures = (counts.failed ?? 0) + (counts.partial ?? 0) + (counts.skipped ?? 0) + (counts.unattempted ?? 0)
    job.status = interrupted || !Object.keys(counts).length || counts.uncertain ? 'uncertain'
      : counts.pending ? writes || failures || job.items?.some(item => item.applied?.length) ? 'warnings' : 'pending'
      : failures ? writes || counts.unchanged || counts.partial ? 'warnings' : 'failed' : 'completed'
    job.counts = counts
    if (entry.eventType === AuditEventType.POLICY_RESTORED || entry.eventType === AuditEventType.POLICY_REVERTED) {
      entry.resource = { ...entry.resource, type: 'policy', id: job.items?.[0]?.targetId ?? job.items?.[0]?.sourceId ?? entry.resource.id }
    }
    entry.result = job.status === 'completed' ? AuditResult.SUCCESS : job.status === 'failed' ? AuditResult.FAILURE : AuditResult.PARTIAL
    entry.severity = job.status === 'completed' ? AuditSeverity.INFO : job.status === 'failed' ? AuditSeverity.ERROR : AuditSeverity.WARNING
    if (entry.eventType === AuditEventType.RESTORE_COMPLETED && job.status === 'failed') entry.eventType = AuditEventType.RESTORE_FAILED
  }

  private enqueueCheckpoint(id: string): void {
    const checkpoint = this.checkpoints[id]!
    const receiptId = checkpoint.correlation ? `restore:${checkpoint.entry.job!.runId}`
      : checkpoint.completionId ?? (checkpoint.completion ? id : undefined)
    if (receiptId) {
      const now = Date.now()
      const receipts = Object.fromEntries(Object.entries(this.receipts).filter(([key, receipt]) =>
        !key.startsWith('restore:') || now - receipt.at < 60 * 60_000))
      receipts[receiptId] = { at: now, ready: receipts[receiptId]?.ready || checkpoint.ready, correlation: checkpoint.correlation }
      this.options.store?.set(RECEIPTS, JSON.stringify(receipts))
      this.receipts = receipts
    }
    queueEvent(checkpoint.binding.storageAccountName, checkpoint.entry)
    const { [id]: _checkpoint, ...remaining } = this.checkpoints
    this.save(remaining)
  }

  checkpointBackup(binding: AuditBinding, input: CreateAuditLogInput, stamp: { id: string; timestamp: string }): void {
    const entry = this.entry(binding, input, stamp)
    this.save({ ...this.checkpoints, [entry.id]: { binding: { ...binding, user: entry.user }, entry } })
  }

  /** Older builds left their backup checkpoints here before they recorded run ownership. */
  backupCheckpoints(): BackupRunIdentity[] {
    return Object.values(this.checkpoints).flatMap(({ binding, entry }) =>
      isBackupCheckpoint(entry) && entry.job?.runId === entry.id
        ? [{ id: entry.id, tenantId: binding.tenantId, storageAccountName: binding.storageAccountName, startTime: entry.timestamp }]
        : [])
  }

  private finishCheckpoint(checkpoint: Checkpoint): void {
    const { entry, binding } = checkpoint
    const id = entry.id
    // A failed journal write must not leave an uncertain start in place of a known result.
    this.checkpoints = { ...this.checkpoints, [id]: { ...checkpoint, finished: true } }
    try { this.save(this.checkpoints) }
    catch {
      warning()
      // These terminal events have no restore correlation receipt to persist before entering the outbox.
      if (isStandaloneTerminal(entry)) {
        try { queueEvent(binding.storageAccountName, entry) } catch { warning() }
      }
      this.save(this.checkpoints)
    }
    this.enqueueCheckpoint(id)
  }

  async recoverBackups(reconcile: (binding: AuditBinding, entry: AuditLogEntry) => Promise<AuditLogEntry>): Promise<void> {
    for (const id of this.interruptedBackups) {
      const checkpoint = this.checkpoints[id]
      if (!checkpoint || checkpoint.finished) {
        this.interruptedBackups.delete(id)
        continue
      }
      try {
        // The outbox can already contain the true terminal outcome if the journal write failed.
        let queued: AuditLogEntry | undefined
        try {
          queued = pendingEvents(checkpoint.binding.storageAccountName).find(entry =>
            entry.id === id && isBackupCheckpoint(entry) && entry.user.tenantId === checkpoint.entry.user.tenantId)
        } catch { warning() }
        const entry = queued ?? await reconcile(checkpoint.binding, checkpoint.entry)
        if (this.checkpoints[id] === checkpoint) this.finishCheckpoint({ ...checkpoint, entry: projectEntry(entry) })
        this.interruptedBackups.delete(id)
      } catch { warning() }
    }
  }

  /** Called at startup before new work is admitted. Never replay Graph writes. */
  recover(): void {
    for (const [id, checkpoint] of Object.entries(this.checkpoints)) {
      try {
        if (!checkpoint.finished) {
          if (isBackupCheckpoint(checkpoint.entry)) continue
          if ((checkpoint.completionId || checkpoint.completion) && !checkpoint.ready) {
            checkpoint.entry.job!.reason = 'PROCESS_INTERRUPTED'
          }
          this.finalize(checkpoint.entry, !checkpoint.ready)
          this.save({ ...this.checkpoints, [id]: { ...checkpoint, finished: true } })
        }
        this.enqueueCheckpoint(id)
      } catch { warning() }
    }
  }

  async retry(): Promise<void> {
    if (this.retrying) return
    this.retrying = true
    try {
      for (const [id, checkpoint] of Object.entries(this.checkpoints)) {
        if (checkpoint.finished) {
          try { this.enqueueCheckpoint(id) } catch { warning() }
        }
      }
      for (const account of queuedAccounts()) {
        const pending = pendingEvents(account)
        const offset = (this.retryOffsets.get(account) ?? 0) % Math.max(1, pending.length)
        this.retryOffsets.set(account, offset + 10)
        for (const entry of pending.slice(offset, offset + 10)) {
          // Keep outbox evidence until any stale on-disk checkpoint has been removed.
          if (this.checkpoints[entry.id]) continue
          try { await this.deliver(account, entry) } catch { /* A pending event cannot block the next tenant. */ }
        }
      }
    } finally {
      this.retrying = false
    }
  }

  private stuckReaderEvents(tenant: string, currentRegistrationId?: string) {
    return queuedAccounts().flatMap(account => pendingEvents(account)
      .filter(entry => entry.user.tenantId === tenant.toLowerCase() && entry.job?.producer === 'backup-reader' &&
        (!currentRegistrationId || entry.job.registrationId?.toLowerCase() !== currentRegistrationId.toLowerCase()))
      .map(entry => ({ account, entry })))
  }

  stuckReaderCount(tenant: string, currentRegistrationId?: string): number {
    return this.stuckReaderEvents(tenant, currentRegistrationId).length
  }

  async deliverStuckReader(
    tenant: string, currentRegistrationId: string | undefined, admin: AuditUser,
    storage: (account: string) => AuditStorageService,
  ): Promise<void> {
    let failed = 0
    for (const { account, entry } of this.stuckReaderEvents(tenant, currentRegistrationId).slice(0, 20)) {
      try { await storage(account).deliverReaderAsAdmin(entry, admin) } catch { failed++ }
    }
    if (failed) throw new Error(`Could not deliver ${failed} audit event(s). Check your Azure storage access and try again.`)
  }

  private countPending(accounts: string[], matches: (entry: AuditLogEntry, account: string) => boolean): number {
    const ids = new Set(accounts.flatMap(account => pendingEvents(account)
      .filter(entry => matches(entry, account)).map(entry => entry.id)))
    for (const [id, checkpoint] of Object.entries(this.checkpoints)) {
      if ((checkpoint.finished || this.interruptedBackups.has(id) || ((checkpoint.completionId || checkpoint.completion) && !checkpoint.ready)) &&
        matches(checkpoint.entry, checkpoint.binding.storageAccountName)) ids.add(checkpoint.entry.id)
    }
    return ids.size
  }

  pending(tenant: string, producer: AuditJob['producer']): number {
    return this.countPending(queuedAccounts(), entry => entry.user.tenantId === tenant.toLowerCase() && entry.job?.producer === producer)
  }

  pendingForStorage(account: string, tenant: string): number {
    return this.countPending([account], (entry, boundAccount) => boundAccount === account &&
      (!entry.user.tenantId || entry.user.tenantId.toLowerCase() === tenant.toLowerCase()))
  }
}

let sink: AuditSink | undefined
export function setMainAuditSink(value: AuditSink | undefined): void { sink = value }
export function mainAuditSink(): AuditSink | undefined { return sink }

export function auditUserFromToken(token: string, tenant: string, requireDelegated = false): AuditUser | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))
    if (claims.tid?.toLowerCase() !== tenant.toLowerCase() || !isGuid(claims.oid) || (requireDelegated && !claims.scp)) return undefined
    return {
      id: claims.oid,
      email: claims.scp ? claims.preferred_username ?? claims.upn ?? '' : '',
      name: claims.scp ? claims.name ?? claims.preferred_username ?? 'Signed-in administrator' : 'Application service principal',
    }
  } catch { return undefined }
}
