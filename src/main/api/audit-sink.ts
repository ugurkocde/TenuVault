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
}

interface Checkpoint {
  binding: AuditBinding
  entry: AuditLogEntry
  finished?: boolean
}

const JOURNAL = 'audit.restore-jobs'
const warning = () => console.warn('[audit] Audit delivery requires attention')

/**
 * Main process API for jobs, approval stages and policy events. Obtain the destination binding
 * before executing, keep the operation ID across continuations, and use a fresh run ID per attempt.
 * Return the operation result independently of audit delivery.
 */
export class AuditSink {
  private checkpoints: Record<string, Checkpoint>
  private retrying = false
  private readonly retryOffsets = new Map<string, number>()

  constructor(private readonly options: AuditSinkOptions) {
    this.checkpoints = JSON.parse(options.store?.get(JOURNAL) ?? '{}')
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
    queueEvent(binding.storageAccountName, entry)
    await this.deliver(binding.storageAccountName, entry)
  }

  private async deliver(account: string, entry: AuditLogEntry): Promise<void> {
    const storage = await this.options.transport(account, entry)
    await storage.deliver(entry)
  }

  begin(binding: AuditBinding, input: CreateAuditLogInput & { job: AuditJob }): {
    correlate(operationId: string): void
    started(index: number): void
    item(index: number, item: AuditJobItem): void
    finish(uncertain?: boolean): void
  } {
    const entry = this.entry(binding, input)
    let finished = false
    const persist = (finished = false) => {
      this.save({ ...this.checkpoints, [entry.id]: { binding: { ...binding, user: entry.user }, entry, finished } })
    }
    try { persist() } catch { warning() }
    const storeItem = (index: number, item: AuditJobItem) => {
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
      finish: (uncertain = false) => {
        if (finished) return
        finished = true
        entry.timestamp = new Date().toISOString()
        this.finalize(entry, uncertain)
        try {
          persist(true)
          this.enqueueCheckpoint(entry.id)
          void this.deliver(binding.storageAccountName, entry).catch(warning)
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
    queueEvent(checkpoint.binding.storageAccountName, checkpoint.entry)
    const { [id]: _checkpoint, ...remaining } = this.checkpoints
    this.save(remaining)
  }

  /** Called at startup before new work is admitted. Never replay Graph writes. */
  recover(): void {
    for (const [id, checkpoint] of Object.entries(this.checkpoints)) {
      try {
        if (!checkpoint.finished) {
          this.finalize(checkpoint.entry, true)
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

  pending(tenant: string, producer: AuditJob['producer']): number {
    const matches = (entry: AuditLogEntry) => entry.user.tenantId === tenant.toLowerCase() && entry.job?.producer === producer
    const ids = new Set(queuedAccounts().flatMap(account => pendingEvents(account).filter(matches).map(entry => entry.id)))
    for (const checkpoint of Object.values(this.checkpoints)) {
      if (checkpoint.finished && matches(checkpoint.entry)) ids.add(checkpoint.entry.id)
    }
    return ids.size
  }
}

let sink: AuditSink | undefined
export function setMainAuditSink(value: AuditSink | undefined): void { sink = value }
export function mainAuditSink(): AuditSink | undefined { return sink }

export function auditUserFromToken(token: string, tenant: string): AuditUser | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))
    if (claims.tid?.toLowerCase() !== tenant.toLowerCase() || !isGuid(claims.oid)) return undefined
    return {
      id: claims.oid,
      email: claims.scp ? claims.preferred_username ?? claims.upn ?? '' : '',
      name: claims.scp ? claims.name ?? claims.preferred_username ?? 'Signed-in administrator' : 'Application service principal',
    }
  } catch { return undefined }
}
