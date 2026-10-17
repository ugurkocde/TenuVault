import { backupEvent, driftEvent, restoreEvent } from "../../../shared/notifications/envelope"
import { allows } from "../../../shared/plans"
import type { FeatureDeps } from "../deps"
import { emit, type NotificationOptions } from "./service"

/**
 * Event producers for work the desktop app itself performed. Each one is best-effort:
 * a notification failure must never fail the backup or the scan that produced it, so
 * callers fire and forget with a catch.
 */

export interface BackupOutcome {
  status: "Success" | "CompletedWithWarnings" | "Failed"
  backupFolder: string
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

export async function emitBackupOutcome(deps: FeatureDeps, tenantId: string, outcome: BackupOutcome, options: NotificationOptions = {}): Promise<number> {
  if (!(await licensed(deps, tenantId))) return 0
  const envelope = backupEvent({
    tenantId,
    tenantName: deps.tenant(tenantId)?.name ?? null,
    status: outcome.status,
    backupFolder: outcome.backupFolder,
    occurredAt: outcome.finishedAt,
    totalPolicies: outcome.totalPolicies,
    failures: outcome.failures,
    failedTypes: outcome.failedTypes,
    trigger: outcome.trigger,
    message: outcome.message,
    source: "desktop",
  })
  return emit(deps, tenantId, envelope, options)
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
export async function emitDriftOutcome(deps: FeatureDeps, tenantId: string, outcome: DriftOutcome, options: NotificationOptions = {}): Promise<number> {
  if (outcome.added + outcome.modified + outcome.deleted === 0) return 0
  if (!(await licensed(deps, tenantId))) return 0
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
  return emit(deps, tenantId, envelope, options)
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
