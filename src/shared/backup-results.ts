/**
 * What a backup run did per type, kept beside the text log so progress views can show results
 * without reading log wording. The engine fills it as the run goes; the text log stays the support record.
 */

/**
 * - reading: listed but not finished yet.
 * - empty: the tenant has none of this type.
 * - saved: every listed item was handled; `failed` says how many could not be saved.
 * - skipped: left out for a missing permission, with the reason.
 * - unreadable: the list could not be read, with the reason.
 */
export type BackupTypeState = "reading" | "empty" | "saved" | "skipped" | "unreadable"

export interface BackupTypeResult {
  folder: string
  label: string
  area: string
  /** Tenant inventory such as Autopilot devices, which the policy total leaves out. */
  inventory?: boolean
  state: BackupTypeState
  found?: number
  saved: number
  failed: number
  builtInSkipped?: number
  reason?: string
  /** Per item failures, capped at MAX_ITEM_ERRORS; `failed` holds the full count. */
  errors?: string[]
}

export interface BackupNotice {
  level: "info" | "warning"
  message: string
}

export interface BackupResults {
  types: BackupTypeResult[]
  notices: BackupNotice[]
  /** Set when the run reached its manifest. */
  totalPolicies?: number
}

export const MAX_ITEM_ERRORS = 5
