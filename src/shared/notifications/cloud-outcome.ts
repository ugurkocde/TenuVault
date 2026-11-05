/**
 * The result note a cloud backup run leaves for the Azure watcher, and the alert it becomes.
 *
 * Backups and their status are sealed with the recovery key, which the watcher never has. So
 * the cloud backup runbook (Invoke-TenuVaultBackup.ps1) writes, after every run, one small
 * unsealed note to its own container `tenuvault-backup-results` under `cloud-backup-outcomes/`.
 * A container of its own, because the backup identity may write there: in the watcher's state
 * container it could rewrite the watcher's state. It holds only what a backup alert shows anyway: status, folder
 * name, counts, failed type names and the time. Never policy content, names or messages.
 *
 * The watcher (Invoke-TenuVaultNotificationCheck.ps1, ConvertFrom-TenuVaultBackupOutcome)
 * validates a note the same way as this module and turns it into the same backup event the
 * desktop sends; test/notification-watcher-script.test.ts compares both.
 */
import { backupEvent, type NotificationEnvelope } from "./envelope"

export const CLOUD_OUTCOME_SCHEMA = "tenuvault.cloud-backup-outcome/v1"
export const CLOUD_OUTCOME_CONTAINER = "tenuvault-backup-results"
export const CLOUD_OUTCOME_PREFIX = "cloud-backup-outcomes/"

export type CloudOutcomeStatus = "Success" | "CompletedWithWarnings" | "Failed"

export interface CloudBackupOutcome {
  status: CloudOutcomeStatus
  runId: string
  backupFolder: string | null
  finishedAt: string
  totalPolicies: number | null
  failures: number
  failedTypes: string[]
}

// ASCII only and anchored at the very end, the same as the runbook's \z patterns.
const FOLDER = /^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$/
const RUN_ID = /^[A-Za-z0-9-]{1,100}$/
const TYPE_NAME = /^[A-Za-z]{1,64}$/
/** A time with an explicit zone: a note written elsewhere must not be read in local time. */
const ZONED_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,3})?(Z|[+-]([0-9]{2}):([0-9]{2}))$/

/**
 * A real calendar time with an explicit zone. Date.parse rolls 2026-02-30 over to March and
 * T24:00 to the next day; the watcher (.NET DateTimeOffset) rejects both, and offsets past
 * 14 hours, so this does too.
 */
function isZonedTime(text: string): boolean {
  const match = ZONED_TIME.exec(text)
  if (!match) return false
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false
  if (day > daysInMonth(year, month)) return false
  if (match[9] !== undefined) {
    const offsetMinutes = Number(match[9]) * 60 + Number(match[10])
    if (Number(match[10]) > 59 || offsetMinutes > 14 * 60) return false
  }
  // The UTC time must stay within years 1 to 9999, as .NET requires.
  const at = Date.parse(text)
  return at >= Date.parse("0001-01-01T00:00:00.000Z") && at <= Date.parse("9999-12-31T23:59:59.999Z")
}

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
const daysInMonth = (year: number, month: number) => (month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31)

/** Fixed summaries: a note never carries a message, so nothing from the run reaches a channel as text. */
export const CLOUD_OUTCOME_SUMMARY: Record<CloudOutcomeStatus, string> = {
  Success: "The cloud backup in Azure completed successfully.",
  CompletedWithWarnings: "The cloud backup in Azure saved policies, but some could not be read. Open TenuVault for the details.",
  Failed: "The cloud backup in Azure failed, so this backup is incomplete. Open the runbook job in the Automation account for the reason.",
}

const count = (value: unknown, max: number): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null)

/** Validates a note for this tenant. Null when it is not a usable note of this tenant. */
export function parseCloudOutcome(value: unknown, tenantId: string): CloudBackupOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const note = value as Record<string, unknown>
  if (note.schema !== CLOUD_OUTCOME_SCHEMA) return null
  if (typeof note.tenantId !== "string" || note.tenantId.toLowerCase() !== tenantId.toLowerCase()) return null
  if (note.status !== "Success" && note.status !== "CompletedWithWarnings" && note.status !== "Failed") return null
  if (typeof note.runId !== "string" || !RUN_ID.test(note.runId)) return null
  if (note.backupFolder !== null && (typeof note.backupFolder !== "string" || !FOLDER.test(note.backupFolder))) return null
  if (typeof note.finishedAt !== "string" || !isZonedTime(note.finishedAt) || Number.isNaN(Date.parse(note.finishedAt))) return null
  const failedTypes = Array.isArray(note.failedTypes) ? note.failedTypes.filter((entry): entry is string => typeof entry === "string" && TYPE_NAME.test(entry)).slice(0, 10) : []
  return {
    status: note.status,
    runId: note.runId,
    backupFolder: note.backupFolder,
    finishedAt: new Date(note.finishedAt).toISOString(),
    totalPolicies: count(note.totalPolicies, 1_000_000),
    failures: count(note.failures, 1_000_000) ?? 0,
    failedTypes,
  }
}

/** The backup event a note becomes, keyed by its folder (or its run when no folder was claimed). */
export function cloudOutcomeEvent(outcome: CloudBackupOutcome, tenantId: string, tenantName: string | null, source: "desktop" | "azure-watcher" = "azure-watcher"): NotificationEnvelope {
  return backupEvent({
    tenantId,
    tenantName,
    status: outcome.status,
    backupFolder: outcome.backupFolder,
    naturalKey: outcome.backupFolder ?? `run:${outcome.runId}`,
    occurredAt: outcome.finishedAt,
    totalPolicies: outcome.totalPolicies,
    failures: outcome.failures,
    failedTypes: outcome.failedTypes,
    trigger: "Cloud backup schedule",
    message: CLOUD_OUTCOME_SUMMARY[outcome.status],
    source,
  })
}
