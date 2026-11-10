import type { KeyValueStore } from "../storage/secure-store"

export const TENANT_TRIAL_STATE_KEY = "license.tenantTrials"

export interface StoredTenantTrial {
  firstConnectedAt?: number
  lastAttemptAt?: number
  stopped?: boolean
  refusalReason?: string
  refusalAt?: number
  refusalVersion?: string
  trialEndsAt?: number
  refusal?: string
  activationId?: string
  token?: string
  canEnd?: boolean
  extended?: boolean
  email?: string
  acknowledged?: boolean
  endedAcknowledged?: boolean
  endedAt?: number
}

export function readTenantTrials(store: KeyValueStore, existing: string[]): Record<string, StoredTenantTrial> {
  try {
    const saved = store.get(TENANT_TRIAL_STATE_KEY)
    if (!saved) return Object.fromEntries(existing.map(id => [id.toLowerCase(), { stopped: true }]))
    const parsed: unknown = JSON.parse(saved)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([id, record]) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) && record && typeof record === "object" && !Array.isArray(record),
    ).map(([id, record]) => {
      const clean: Record<string, unknown> = {}
      for (const field of ["firstConnectedAt", "lastAttemptAt", "endedAt", "trialEndsAt", "refusalAt"]) if (typeof record[field] === "number" && Number.isFinite(record[field])) clean[field] = record[field]
      for (const field of ["stopped", "canEnd", "extended", "acknowledged", "endedAcknowledged"]) if (typeof record[field] === "boolean") clean[field] = record[field]
      for (const field of ["refusal", "refusalReason", "refusalVersion", "activationId", "token", "email"]) if (typeof record[field] === "string") clean[field] = record[field]
      return [id, clean]
    }))
  } catch {
    return Object.fromEntries(existing.map(id => [id.toLowerCase(), { stopped: true }]))
  }
}
