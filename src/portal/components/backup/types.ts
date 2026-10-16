/** A backup as /api/list-backups describes it. */
export interface BackupSummary {
  id: string
  timestamp: string
  /** How the backup started; null for backups made before this was recorded. */
  type: "manual" | "scheduled" | "tray" | null
  status: string
  totalPolicies: number
  /** Items per registry folder. */
  counts?: Record<string, number>
  /** Stored bytes per registry folder, from the same listing as `counts`. */
  sizes?: Record<string, number>
  scope: { excluded: string[]; description: string } | null
  failures?: number
  skippedTypes?: string[]
  failedTypes?: string[]
  size: number
  /** Seconds, or a preformatted string from older backups; null when unknown. */
  duration: number | string | null
  /** Compared with the newest older comparable backup; null when there is none. */
  changes: { added: number; modified: number; removed: number } | null
  comparedWith: string | null
  /** Why the metadata could not be read, when it could not. */
  error?: string
}

/** The tenant fields backup and restore requests need. */
export interface BackupTenant {
  name: string
  credentials: { tenantId: string; appId: string; clientSecret: string }
  storageAccountName: string
}

export const TRIGGER_LABEL: Record<NonNullable<BackupSummary["type"]>, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  tray: "From tray",
}

export function formatDuration(value: BackupSummary["duration"]): string {
  if (value === null || value === undefined || value === "") return "Not recorded"
  if (typeof value === "string") return value
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const seconds = value % 60
  return [hours && `${hours}h`, minutes && `${minutes}m`, (seconds || (!hours && !minutes)) && `${seconds}s`].filter(Boolean).join(" ")
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB"
  const units = ["B", "KB", "MB", "GB"]
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${unit === 0 || size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

export function formatDate(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `${new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} (time not recorded)`
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export type StatusKind = "success" | "warning" | "failed" | "running"

export function statusKind(status: string): StatusKind {
  const value = status.toLowerCase()
  if (value.includes("fail") || value === "incomplete") return "failed"
  // "unknown": the metadata could not be read, so whether the backup finished is not known.
  if (value.includes("warn") || value.includes("partial") || value === "unknown") return "warning"
  if (value === "running") return "running"
  return "success"
}

export const STATUS_LABEL: Record<StatusKind, string> = {
  success: "Complete",
  warning: "Completed with warnings",
  failed: "Failed",
  running: "Running",
}

/** The status as shown: the kind's label, named more precisely for stopped and unreadable backups. */
export function statusLabel(status: string): string {
  if (status === "incomplete") return "Incomplete"
  if (status === "unknown") return "Status unknown"
  return STATUS_LABEL[statusKind(status)]
}
