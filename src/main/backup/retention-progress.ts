import { createHash } from "node:crypto"

export interface RetentionProgressStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

export interface VerificationProgress {
  files: Record<string, string>
  complete?: { identity: string; counts: Array<[string, number]> }
  attempts: number
}

export interface FreshVerificationProgress {
  binding: string
  files: Record<string, string>
  done?: boolean
}

export interface DeletionJournalEntry {
  prefixes: string[]
  remnant: boolean
  folders: string[]
  emptyFolders?: boolean
  untagged?: boolean
  remaining: Record<string, string>
  deleted: string[]
  absent?: string[]
  fresh?: Record<string, FreshVerificationProgress>
}

export interface LeaseFailureProgress {
  key: string
  count: number
}

export interface RetentionProgress {
  cursor?: string
  latest?: string
  newest?: string
  newestCompanion?: string
  latestAttempts?: number
  timeAttempts?: number
  leaseFailures?: LeaseFailureProgress
  reviews: Record<string, VerificationProgress>
  deletions?: Record<string, DeletionJournalEntry>
}

export function retentionIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isCompleteReceipt(value: unknown): value is NonNullable<VerificationProgress["complete"]> {
  if (!isPlainRecord(value)) return false
  if (typeof value.identity !== "string" || !value.identity) return false
  if (!Array.isArray(value.counts)) return false
  return value.counts.every(entry =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && isNonNegativeInt(entry[1]),
  )
}

function isVerificationProgress(value: unknown): value is VerificationProgress {
  if (!isPlainRecord(value)) return false
  if (!isNonNegativeInt(value.attempts)) return false
  if (!isPlainRecord(value.files)) return false
  if (!Object.values(value.files).every(receipt => typeof receipt === "string")) return false
  if (value.complete !== undefined && !isCompleteReceipt(value.complete)) return false
  return true
}

export const MAX_FRESH_REPLACEMENTS = 128
export const MAX_FRESH_PREFIX_LENGTH = 256
export const MAX_FRESH_BINDING_LENGTH = 128
// Matches RETENTION_LIMITS.requests, so any fresh verification a run can perform fits in persisted progress.
export const MAX_FRESH_FILES = 100_000
export const MAX_FRESH_FILE_NAME_LENGTH = 1_024
export const MAX_FRESH_RECEIPT_LENGTH = 256

function isFreshVerificationProgress(value: unknown): value is FreshVerificationProgress {
  if (!isPlainRecord(value)) return false
  if (typeof value.binding !== "string" || !value.binding || value.binding.length > MAX_FRESH_BINDING_LENGTH) return false
  if (!isPlainRecord(value.files)) return false
  const fileEntries = Object.entries(value.files)
  if (fileEntries.length > MAX_FRESH_FILES) return false
  if (!fileEntries.every(([name, receipt]) =>
    name.length > 0 && name.length <= MAX_FRESH_FILE_NAME_LENGTH
    && typeof receipt === "string" && receipt.length > 0 && receipt.length <= MAX_FRESH_RECEIPT_LENGTH)) return false
  if (value.done !== undefined && typeof value.done !== "boolean") return false
  return true
}

function isDeletionJournalEntry(value: unknown): value is DeletionJournalEntry {
  if (!isPlainRecord(value)) return false
  if (!Array.isArray(value.prefixes) || value.prefixes.length === 0
    || !value.prefixes.every(prefix => typeof prefix === "string" && prefix.endsWith("/"))) return false
  if (typeof value.remnant !== "boolean") return false
  if (!Array.isArray(value.folders) || !value.folders.every(folder => typeof folder === "string")) return false
  if (value.emptyFolders !== undefined && typeof value.emptyFolders !== "boolean") return false
  if (value.untagged !== undefined && typeof value.untagged !== "boolean") return false
  if (!isPlainRecord(value.remaining)
    || !Object.values(value.remaining).every(etag => typeof etag === "string" && etag.length > 0)) return false
  if (!Array.isArray(value.deleted) || !value.deleted.every(name => typeof name === "string")) return false
  if (value.absent !== undefined && (!Array.isArray(value.absent) || !value.absent.every(name => typeof name === "string"))) return false
  if (value.fresh !== undefined) {
    if (!isPlainRecord(value.fresh)) return false
    const freshEntries = Object.entries(value.fresh)
    if (freshEntries.length > MAX_FRESH_REPLACEMENTS) return false
    if (!freshEntries.every(([repPrefix, entry]) =>
      repPrefix.length > 0 && repPrefix.length <= MAX_FRESH_PREFIX_LENGTH
      && repPrefix.endsWith("/") && isFreshVerificationProgress(entry))) return false
  }
  return true
}

function isRetentionProgress(state: unknown): state is RetentionProgress {
  if (!isPlainRecord(state)) return false
  if (state.cursor !== undefined && typeof state.cursor !== "string") return false
  if (state.latest !== undefined && typeof state.latest !== "string") return false
  if (state.newest !== undefined && typeof state.newest !== "string") return false
  if (state.newestCompanion !== undefined && typeof state.newestCompanion !== "string") return false
  if (state.latestAttempts !== undefined && !isNonNegativeInt(state.latestAttempts)) return false
  if (state.timeAttempts !== undefined && !isNonNegativeInt(state.timeAttempts)) return false
  if (state.leaseFailures !== undefined) {
    if (!isPlainRecord(state.leaseFailures) || typeof state.leaseFailures.key !== "string" || !state.leaseFailures.key
      || !isNonNegativeInt(state.leaseFailures.count) || state.leaseFailures.count < 1) return false
  }
  if (!isPlainRecord(state.reviews)) return false
  if (!Object.values(state.reviews).every(isVerificationProgress)) return false
  if (state.deletions !== undefined) {
    if (!isPlainRecord(state.deletions)) return false
    if (!Object.values(state.deletions).every(isDeletionJournalEntry)) return false
  }
  return true
}

export function readRetentionProgress(value: string | null | undefined): RetentionProgress {
  if (value?.startsWith("backup-")) return { cursor: value, reviews: {} }
  if (value) {
    try {
      const state: unknown = JSON.parse(value)
      if (isRetentionProgress(state)) return state
    } catch { /* Old or unreadable progress can always be verified again. */ }
  }
  return { reviews: {} }
}
