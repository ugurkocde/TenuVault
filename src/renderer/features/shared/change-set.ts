import type { ChangeSetRecord, DiffEntry, OperationResult } from "../../../main/features/change-sets/model"
import type { ChangeSetPreview, RollbackPreview } from "../../../main/features/change-sets/engine"

/** Shared renderer types and helpers for workflows that review and apply change sets. */

export type { ChangeSetRecord, ChangeSetPreview, DiffEntry, OperationResult, RollbackPreview }

/** A change set as a workflow route returns it. */
export type ChangeSet = ChangeSetRecord & { id: string; tenantId: string; createdAt: string; updatedAt: string; history?: Array<{ at: string; actor: string | null; reason: string }> }

/** The review and apply calls of one change set, supplied by the owning workflow's route. */
export interface ChangeSetActions {
  preview: () => Promise<ChangeSetPreview>
  approve: (input: { contentHash: string; targetFingerprint: string; reviewer: string; note: string }) => Promise<unknown>
  reject: (input: { reviewer: string; note: string }) => Promise<unknown>
  apply: (contentHash: string) => Promise<unknown>
  retry: (contentHash: string) => Promise<unknown>
  rollbackPreview: () => Promise<RollbackPreview>
  rollbackCreate: () => Promise<{ changeSet: ChangeSet }>
}

export const STATUS_TONE: Record<ChangeSetRecord["status"], "neutral" | "coral" | "success" | "warning" | "danger"> = {
  "in-review": "coral",
  approved: "coral",
  rejected: "neutral",
  stale: "warning",
  applying: "warning",
  applied: "success",
  partial: "warning",
  failed: "danger",
  uncertain: "danger",
}

/** A change set status in words: "in review" instead of the stored "in-review". */
export function statusLabel(status: string): string {
  return status === "in-review" ? "in review" : status
}

export const RESULT_TONE: Record<OperationResult["status"], "neutral" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  writing: "warning",
  verified: "success",
  failed: "danger",
  uncertain: "warning",
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "unknown"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString()
}
