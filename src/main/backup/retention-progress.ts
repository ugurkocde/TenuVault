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

export interface RetentionProgress {
  cursor?: string
  latestAttempts?: number
  reviews: Record<string, VerificationProgress>
}

export function retentionIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function readRetentionProgress(value: string | null | undefined): RetentionProgress {
  if (value?.startsWith("backup-")) return { cursor: value, reviews: {} }
  if (value) {
    try {
      const state = JSON.parse(value)
      if (state?.reviews && typeof state.reviews === "object") return state
    } catch { /* Old or unreadable progress can always be verified again. */ }
  }
  return { reviews: {} }
}
