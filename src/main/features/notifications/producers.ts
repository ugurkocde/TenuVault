import { backupEvent, credentialExpiringEvent, driftEvent, lateBackupEvent, restoreEvent } from "../../../shared/notifications/envelope"
import { allows } from "../../../shared/plans"
import type { FeatureDeps } from "../deps"
import { channelsOf, emit, emitDetailed, type NotificationOptions } from "./service"

/**
 * Event producers for work the desktop app itself performed. Each one is best-effort:
 * a notification failure must never fail the backup or the scan that produced it, so
 * callers fire and forget with a catch.
 */

export interface BackupOutcome {
  status: "Success" | "CompletedWithWarnings" | "Failed"
  backupFolder: string | null
  /** Delivery identity; see BackupEventInput.naturalKey. */
  naturalKey?: string | null
  finishedAt: string
  totalPolicies?: number | null
  failures?: number | null
  failedTypes?: string[]
  trigger?: string | null
  message?: string | null
}

async function licensed(deps: FeatureDeps, tenantId: string): Promise<boolean> {
  try {
    return allows(await deps.plan(tenantId), "notifications")
  } catch {
    return false
  }
}

export interface ProducerResult {
  created: number
  /**
   * A local channel holds this outcome (queued now, or by an earlier attempt of the same slot), so
   * a legacy OS toast for the same outcome can stand down.
   */
  localCreated: boolean
}

function localCreated(deps: FeatureDeps, tenantId: string, channelIds: string[]): boolean {
  const channels = channelsOf(deps, tenantId)
  return channels.some((channel) => channel.kind === "local" && channelIds.includes(channel.id))
}

export async function emitBackupOutcome(deps: FeatureDeps, tenantId: string, outcome: BackupOutcome, options: NotificationOptions = {}): Promise<ProducerResult> {
  if (!(await licensed(deps, tenantId))) return { created: 0, localCreated: false }
  const envelope = backupEvent({
    tenantId,
    tenantName: deps.tenant(tenantId)?.name ?? null,
    status: outcome.status,
    backupFolder: outcome.backupFolder,
    naturalKey: outcome.naturalKey,
    occurredAt: outcome.finishedAt,
    totalPolicies: outcome.totalPolicies,
    failures: outcome.failures,
    failedTypes: outcome.failedTypes,
    trigger: outcome.trigger,
    message: outcome.message,
    source: "desktop",
  })
  const detailed = await emitDetailed(deps, tenantId, envelope, options)
  return { created: detailed.created, localCreated: localCreated(deps, tenantId, detailed.coveredChannelIds) }
}

export interface DriftOutcome {
  jobId: string
  finishedAt: string
  added: number
  modified: number
  deleted: number
  items?: Array<{ title: string; detail?: string }>
}

/** Emits drift.detected, except when nothing changed: silence is the correct signal then. */
export async function emitDriftOutcome(deps: FeatureDeps, tenantId: string, outcome: DriftOutcome, options: NotificationOptions = {}): Promise<ProducerResult> {
  if (outcome.added + outcome.modified + outcome.deleted === 0) return { created: 0, localCreated: false }
  if (!(await licensed(deps, tenantId))) return { created: 0, localCreated: false }
  const envelope = driftEvent({
    tenantId,
    tenantName: deps.tenant(tenantId)?.name ?? null,
    occurredAt: outcome.finishedAt,
    jobId: outcome.jobId,
    added: outcome.added,
    modified: outcome.modified,
    deleted: outcome.deleted,
    items: outcome.items,
    source: "desktop",
  })
  const detailed = await emitDetailed(deps, tenantId, envelope, options)
  return { created: detailed.created, localCreated: localCreated(deps, tenantId, detailed.coveredChannelIds) }
}

export interface ReaderCertificate {
  notAfter: string
  renewalPending: boolean
  /** Now, for the days left; injectable for tests. */
  checkedAt: string
}

/**
 * Emits credential.expiring once per certificate and band (30 days, 7 days, expired).
 * Nothing outside the 30 day window. localCreated lets the legacy toast stand down.
 */
export async function emitCredentialExpiring(deps: FeatureDeps, tenantId: string, certificate: ReaderCertificate, options: NotificationOptions = {}): Promise<ProducerResult> {
  const daysLeft = Math.ceil((Date.parse(certificate.notAfter) - Date.parse(certificate.checkedAt)) / 86_400_000)
  const envelope = credentialExpiringEvent({ tenantId, tenantName: deps.tenant(tenantId)?.name ?? null, occurredAt: certificate.checkedAt, notAfter: certificate.notAfter, daysLeft, renewalPending: certificate.renewalPending, source: "desktop" })
  if (!envelope) return { created: 0, localCreated: false }
  if (!(await licensed(deps, tenantId))) return { created: 0, localCreated: false }
  const detailed = await emitDetailed(deps, tenantId, envelope, options)
  return { created: detailed.created, localCreated: localCreated(deps, tenantId, detailed.coveredChannelIds) }
}

/** A scheduled slot that is being caught up after TenuVault was not running when it was due. */
export async function emitLateBackup(deps: FeatureDeps, tenantId: string, slot: string, options: NotificationOptions = {}): Promise<ProducerResult> {
  if (!(await licensed(deps, tenantId))) return { created: 0, localCreated: false }
  const envelope = lateBackupEvent({ tenantId, tenantName: deps.tenant(tenantId)?.name ?? null, occurredAt: deps.now().toISOString(), slot, source: "desktop" })
  const detailed = await emitDetailed(deps, tenantId, envelope, options)
  return { created: detailed.created, localCreated: localCreated(deps, tenantId, detailed.coveredChannelIds) }
}

export interface RestoreOutcome {
  status: "Completed" | "PartiallyCompleted" | "Failed"
  jobId: string
  finishedAt: string
  restored?: number | null
  failed?: number | null
  partial?: number | null
  message?: string | null
}

export async function emitRestoreOutcome(deps: FeatureDeps, tenantId: string, outcome: RestoreOutcome, options: NotificationOptions = {}): Promise<number> {
  if (!(await licensed(deps, tenantId))) return 0
  const envelope = restoreEvent({
    tenantId,
    tenantName: deps.tenant(tenantId)?.name ?? null,
    status: outcome.status,
    jobId: outcome.jobId,
    occurredAt: outcome.finishedAt,
    restored: outcome.restored,
    failed: outcome.failed,
    partial: outcome.partial,
    message: outcome.message,
    source: "desktop",
  })
  return emit(deps, tenantId, envelope, options)
}
