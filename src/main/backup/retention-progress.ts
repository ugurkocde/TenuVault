import { createHash } from "node:crypto"
import { BACKUP_OWNER_FILE } from "../../shared/constants"

export interface RetentionProgressStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

export interface VerificationProgress {
  files: Record<string, string>
  attempts: number
  failures?: number
  reason?: string
}

export interface DeletionJournalEntry {
  prefix: string
  remaining: Record<string, string>
  types: string[]
  noTypes: boolean
  untagged: boolean
}

export interface RetentionProgress {
  cursor?: string
  latest?: string
  latestAttempts?: number
  reviews: Record<string, VerificationProgress>
  deletes?: Record<string, DeletionJournalEntry>
}

export function retentionIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === "string")
}

function isReview(value: unknown): value is VerificationProgress {
  if (!isRecord(value)) return false
  if (!isNonNegativeInt(value.attempts)) return false
  if (!isStringRecord(value.files)) return false
  if (value.failures !== undefined && !isNonNegativeInt(value.failures)) return false
  if (value.reason !== undefined && typeof value.reason !== "string") return false
  return true
}

function isDeletionJournal(key: string, value: unknown): value is DeletionJournalEntry {
  if (!isRecord(value)) return false
  if (typeof value.prefix !== "string" || !value.prefix || value.prefix !== key) return false
  if (!isStringRecord(value.remaining)) return false
  const remaining = Object.entries(value.remaining)
  if (!remaining.every(([name, etag]) => name.startsWith(key) && name.length > key.length && etag.length > 0 && etag !== "*")) return false
  if (!Array.isArray(value.types) || !value.types.every(entry => typeof entry === "string" && entry.length > 0)) return false
  if (typeof value.noTypes !== "boolean") return false
  if (value.types.length === 0 ? !value.noTypes : value.noTypes) return false
  if (value.noTypes && remaining.some(([name]) => name !== key + "metadata.json" && name !== key + BACKUP_OWNER_FILE)) return false
  if (typeof value.untagged !== "boolean") return false
  return true
}

function isProgress(state: unknown): state is RetentionProgress {
  if (!isRecord(state)) return false
  if (state.cursor !== undefined && typeof state.cursor !== "string") return false
  if (state.latest !== undefined && typeof state.latest !== "string") return false
  if (state.latestAttempts !== undefined && !isNonNegativeInt(state.latestAttempts)) return false
  if (!isRecord(state.reviews) || !Object.values(state.reviews).every(isReview)) return false
  if (state.deletes !== undefined && (!isRecord(state.deletes) || !Object.entries(state.deletes).every(([key, entry]) => isDeletionJournal(key, entry)))) return false
  return true
}

export function readRetentionProgress(value: string | null | undefined): RetentionProgress {
  if (value) {
    try {
      const state = JSON.parse(value)
      if (isProgress(state)) return state
    } catch { /* Unreadable progress can always be verified again. */ }
  }
  return { reviews: {} }
}
