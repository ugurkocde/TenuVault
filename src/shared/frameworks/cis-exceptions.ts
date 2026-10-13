/**
 * Accepted exceptions for CIS findings. An exception records that an admin
 * accepted a non-conforming finding for a bounded time, with an owner and a
 * reason. Expired exceptions stay stored but no longer count as active.
 */

export interface CisException {
  id: string
  benchmark: string
  version: string
  level: 1 | 2
  policyName: string
  settingId: string
  owner: string
  reason: string
  /** Expiry date as YYYY-MM-DD. The exception is active through this date. */
  expiresOn: string
  /** Creation timestamp as an ISO string. */
  createdAt: string
}

export interface NewCisExceptionInput {
  benchmark: string
  version: string
  level: 1 | 2
  policyName: string
  settingId: string
  owner: string
  reason: string
  expiresOn: string
}

export const MAX_EXCEPTIONS = 500
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function trimmed(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`Exception ${field} must be a string.`)
  const text = [...value.trim()].filter(char => { const code = char.codePointAt(0) ?? 0; return code > 31 && (code < 127 || code > 159) }).join("")
  if (!text) throw new Error(`Exception ${field} must not be empty.`)
  if (text.length > max) throw new Error(`Exception ${field} must be at most ${max} characters.`)
  return text
}

/** True when value is a real calendar date written as YYYY-MM-DD. */
export function isDateOnly(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day!))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
}

function validateOne(value: unknown, index: number): CisException {
  const label = `Exception ${index + 1}`
  if (!isRecord(value)) throw new Error(`${label}: expected an object.`)
  const id = trimmed(value.id, "id", 100)
  const benchmark = trimmed(value.benchmark, "benchmark", 100)
  const version = trimmed(value.version, "version", 50)
  if (value.level !== 1 && value.level !== 2) throw new Error(`${label}: level must be 1 or 2.`)
  const policyName = trimmed(value.policyName, "policyName", 200)
  const settingId = trimmed(value.settingId, "settingId", 500)
  const owner = trimmed(value.owner, "owner", 100)
  const reason = trimmed(value.reason, "reason", 500)
  if (typeof value.expiresOn !== "string" || !isDateOnly(value.expiresOn)) throw new Error(`${label}: expiresOn must be a date as YYYY-MM-DD.`)
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error(`${label}: createdAt must be an ISO timestamp.`)
  return { id, benchmark, version, level: value.level, policyName, settingId, owner, reason, expiresOn: value.expiresOn, createdAt: value.createdAt }
}

/** Validates a stored exception list, naming the first problem. */
export function validateExceptions(input: unknown): CisException[] {
  if (!Array.isArray(input)) throw new Error("Exceptions must be an array.")
  if (input.length > MAX_EXCEPTIONS) throw new Error(`Exceptions must contain at most ${MAX_EXCEPTIONS} entries.`)
  const seen = new Set<string>()
  return input.map((entry, index) => {
    const exception = validateOne(entry, index)
    if (seen.has(exception.id)) throw new Error(`Exception ${index + 1}: duplicate id ${exception.id}.`)
    seen.add(exception.id)
    return exception
  })
}

/** Validates the fields for one new exception, without id and createdAt. */
export function validateNewException(input: unknown): NewCisExceptionInput {
  if (!isRecord(input)) throw new Error("Exception input must be an object.")
  const benchmark = trimmed(input.benchmark, "benchmark", 100)
  const version = trimmed(input.version, "version", 50)
  if (input.level !== 1 && input.level !== 2) throw new Error("Exception level must be 1 or 2.")
  const policyName = trimmed(input.policyName, "policyName", 200)
  const settingId = trimmed(input.settingId, "settingId", 500)
  const owner = trimmed(input.owner, "owner", 100)
  const reason = trimmed(input.reason, "reason", 500)
  if (typeof input.expiresOn !== "string" || !isDateOnly(input.expiresOn)) throw new Error("Exception expiresOn must be a date as YYYY-MM-DD.")
  return { benchmark, version, level: input.level, policyName, settingId, owner, reason, expiresOn: input.expiresOn }
}

/** Stable key joining the finding identity an exception applies to. */
export function exceptionKey(benchmark: string, version: string, level: 1 | 2, policyName: string, settingId: string): string {
  return JSON.stringify([benchmark, version, level, policyName, settingId])
}

/** An exception is active through its expiry date; today may be a date or an ISO timestamp. */
export function isActive(exception: CisException, todayISO: string): boolean {
  return exception.expiresOn >= todayISO.slice(0, 10)
}
