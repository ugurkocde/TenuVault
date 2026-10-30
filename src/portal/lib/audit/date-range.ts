export interface AuditDateRange {
  startDate: string
  endDate: string
}

function localDateValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function defaultAuditDateRange(now = new Date()): AuditDateRange {
  const start = new Date(now)
  start.setDate(start.getDate() - 6)
  return { startDate: localDateValue(start), endDate: localDateValue(now) }
}

/** The widest single audit read (90 days), for links that name one recorded decision. */
export function wideAuditDateRange(now = new Date()): AuditDateRange {
  const start = new Date(now)
  start.setDate(start.getDate() - 89)
  return { startDate: localDateValue(start), endDate: localDateValue(now) }
}

/** Convert picker days in the user's time zone to instants shared by all audit routes. */
export function auditDateFilter(range: AuditDateRange) {
  return {
    startDate: range.startDate ? new Date(`${range.startDate}T00:00:00`).toISOString() : undefined,
    endDate: range.endDate ? new Date(`${range.endDate}T23:59:59.999`).toISOString() : undefined,
  }
}
