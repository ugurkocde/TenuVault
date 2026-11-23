export const AUDIT_ARCHIVE_FILE = "AuditEvents/auditEvents.json"
export const AUDIT_ARCHIVE_WARNING = "Intune audit log not archived. The next backup will retry from the last saved archive."
export const AUDIT_ARCHIVE_OVERLAP_MS = 10 * 60_000
export const AUDIT_ARCHIVE_HISTORY_MS = 365 * 24 * 60 * 60_000

export interface AuditArchiveWindow {
  from: string
  to: string
  count: number
}

export interface AuditArchive {
  window: AuditArchiveWindow
  value: Record<string, unknown>[]
}

export function auditArchiveWindow(value: unknown): AuditArchiveWindow | undefined {
  if (!value || typeof value !== "object") return undefined
  const { from, to, count } = value as Partial<AuditArchiveWindow>
  if (typeof from !== "string" || typeof to !== "string" || !(Date.parse(from) <= Date.parse(to))) return undefined
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined
  return { from, to, count }
}

export function auditArchive(value: Record<string, unknown> | null, expected: AuditArchiveWindow): AuditArchive {
  const window = auditArchiveWindow(value?.window)
  const events = value?.value
  if (!window || window.from !== expected.from || window.to !== expected.to || window.count !== expected.count
    || !Array.isArray(events) || events.length !== window.count
    || events.some((event) => !event || typeof event.id !== "string" || !event.id)) {
    throw new Error("The saved Intune audit archive is missing or invalid.")
  }
  return { window, value: events }
}
