import { randomUUID } from 'node:crypto'
import { assertStorageAccountName } from '../../shared/storage-account'
import { isGuid } from '../../shared/security'
import type { KeyValueStore } from '../storage/secure-store'
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
  item(index: number, item: AuditJobItem): void
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
const warning = () => console.warn('[audit] Audit delivery requires attention')
const isBackupCheckpoint = (entry: AuditLogEntry) =>
  entry.eventType === AuditEventType.BACKUP_COMPLETED || entry.eventType === AuditEventType.BACKUP_FAILED ||
  entry.eventType === AuditEventType.BACKUP_CANCELLED

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
    this.checkpoints = JSON.parse(options.store?.get(JOURNAL) ?? '{}')
    this.receipts = JSON.parse(options.store?.get(RECEIPTS) ?? '{}')
    this.interruptedBackups = new Set(Object.entries(this.checkpoints)
      .filter(([, checkpoint]) => !checkpoint.finished && isBackupCheckpoint(checkpoint.entry)).map(([id]) => id))
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
    if (this.checkpoints[entry.id]) this.finishBackupCheckpoint(entry.id, entry)
    else queueEvent(binding.storageAccountName, entry)
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

  approvalCompletionReady(eventId: string): boolean {
    return !!(this.checkpoints[eventId]?.ready || this.receipts[eventId]?.ready)
      || Object.values(this.checkpoints).some(checkpoint => checkpoint.completionId === eventId && checkpoint.ready)
  }

  begin(binding: AuditBinding, input: CreateAuditLogInput & { job: AuditJob }): AuditProgress
  begin(binding: AuditBinding, input: CreateAuditLogInput & { job: AuditJob }, options: RestoreAuditOptions): AuditProgress | undefined
  begin(binding: AuditBinding, input: CreateAuditLogInput & { job: AuditJob }, options: RestoreAuditOptions = {}): AuditProgress | undefined {
    let completionId = options.eventId
    if (completionId && this.approvalCompletionReady(completionId)) return undefined
    // Preserve interrupted attempts while keeping the request's receipt key for deduplication.
    const previous = completionId && (this.checkpoints[completionId] || this.receipts[completionId])
    const id = previous ? randomUUID() : completionId
    const entry = this.entry(binding, input, id ? { id, timestamp: new Date().toISOString() } : undefined)
    if (previous) entry.job!.runId = entry.id
    const bound = { ...binding, user: entry.user }
    let finished = false
    let ready = false
    const persist = (finished = false) => {
      this.save({ ...this.checkpoints, [entry.id]: { binding: bound, entry, finished, ready, completionId, correlation: options.correlation } })
    }
    try { persist() } catch { warning() }
    const storeItem = (index: number, item: AuditJobItem) => {
      if (finished) return
      entry.job!.items![index] = projectItem(item)
      try { persist() } catch { warning() }
    }
    return {
      correlate: operationId => {
        entry.job!.operationId = operationId
        entry.context.correlationId = operationId
        try { persist() } catch { warning() }
      },
      started: index => storeItem(index, { ...entry.job!.items![index]!, outcome: 'uncertain', reason: 'PROCESS_INTERRUPTED' }),
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
          persist(true)
          this.enqueueCheckpoint(entry.id)
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

  private finishBackupCheckpoint(id: string, input: AuditLogEntry): void {
    const checkpoint = this.checkpoints[id]!
    this.save({ ...this.checkpoints, [id]: { ...checkpoint, entry: projectEntry(input), finished: true } })
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
        const entry = await reconcile(checkpoint.binding, checkpoint.entry)
        this.finishBackupCheckpoint(id, entry)
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

  pending(tenant: string, producer: AuditJob['producer']): number {
    const matches = (entry: AuditLogEntry) => entry.user.tenantId === tenant.toLowerCase() && entry.job?.producer === producer
    const ids = new Set(queuedAccounts().flatMap(account => pendingEvents(account).filter(matches).map(entry => entry.id)))
    for (const [id, checkpoint] of Object.entries(this.checkpoints)) {
      if ((checkpoint.finished || this.interruptedBackups.has(id) || ((checkpoint.completionId || checkpoint.completion) && !checkpoint.ready)) &&
        matches(checkpoint.entry)) ids.add(checkpoint.entry.id)
    }
    return ids.size
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
