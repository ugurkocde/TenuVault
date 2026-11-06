import type { Tenant } from "~/contexts/TenantContext"
import type { BackupSummary } from "~/components/backup/types"
import { featureCall } from "../../lib/feature-api"
import { backupCompleteness, type DriftBackupRef } from "../../../shared/intune/drift"
import type { ChangeReport, ReportSummary } from "../../../shared/reports/change-report"

export type Recipient = { type: "address"; address: string } | { type: "group"; groupId: string; displayName?: string | null }
export type AttachmentFormat = "pdf" | "markdown"

export interface SendResult {
  at: string
  ok: boolean
  recipients: number
  attachment: AttachmentFormat | null
  error: string | null
  automatic: boolean
}

export interface ReportSettings {
  recipients: Recipient[]
  afterScheduledBackup: boolean
  skipEmpty: boolean
  includeValues: boolean
  includeActors: boolean
  attachment: AttachmentFormat
  lastAutomatic: { at: string; backup: string | null; outcome: "sent" | "skipped" | "failed"; message: string; reportId: string | null } | null
}

export interface ListedReport {
  id: string
  title: string
  summary: string
  createdAt: string
  trigger: "manual" | "scheduled"
  from: DriftBackupRef
  to: DriftBackupRef
  counts: ReportSummary
  audit: "included" | "unavailable"
  values: boolean
  lastSend: SendResult | null
}

export interface ReportsStatus {
  licensed: boolean
  runtimeNote: string
  settings: ReportSettings
  reports: ListedReport[]
}

export type ExportFormat = "pdf" | "markdown" | "json"

export const reportsApi = {
  status: (tenant: Tenant) => featureCall<ReportsStatus>("/api/reports", tenant, "get-status"),
  report: (tenant: Tenant, reportId: string) => featureCall<{ report: ChangeReport; sends: SendResult[] }>("/api/reports", tenant, "get-report", { reportId }),
  generate: (tenant: Tenant, pair: { baseline: string; comparison: string } | null) =>
    featureCall<{ report: ListedReport }>("/api/reports", tenant, "generate", pair ?? {}),
  exportFile: (tenant: Tenant, reportId: string, format: ExportFormat) =>
    featureCall<{ fileName: string; data: string; encoding: "utf8" | "base64" }>("/api/reports", tenant, "get-export", { reportId, format }),
  send: (tenant: Tenant, reportId: string, recipients?: Recipient[]) =>
    featureCall<{ send: SendResult }>("/api/reports", tenant, "send", { reportId, ...(recipients ? { recipients } : {}) }),
  saveSettings: (tenant: Tenant, change: Partial<Omit<ReportSettings, "lastAutomatic">>) =>
    featureCall<{ settings: ReportSettings }>("/api/reports", tenant, "save-settings", change),
  remove: (tenant: Tenant, reportId: string) => featureCall<{ removed: string }>("/api/reports", tenant, "remove-report", { reportId }),
}

export type Period = "previous" | "7" | "30" | "custom"

export const PERIOD_LABELS: Record<Period, string> = {
  previous: "Since the previous backup",
  "7": "Last 7 days",
  "30": "Last 30 days",
  custom: "Choose two backups",
}

/**
 * The backups a period compares, from the tenant's backup list (newest first): the newest complete
 * backup, and the newest complete one at least `days` older, or the oldest complete one when the
 * history is shorter. Null when fewer than two complete backups exist. "previous" is the two newest.
 */
export function periodPair(backups: BackupSummary[], period: Exclude<Period, "custom">): { baseline: string; comparison: string } | null {
  const complete = backups.filter((backup) => backupCompleteness(backup.status) === "complete")
  if (complete.length < 2) return null
  const newest = complete[0]!
  if (period === "previous") return { baseline: complete[1]!.id, comparison: newest.id }
  const cutoff = Date.parse(newest.timestamp) - Number(period) * 86_400_000
  const baseline = complete.slice(1).find((backup) => Date.parse(backup.timestamp) <= cutoff) ?? complete[complete.length - 1]!
  return { baseline: baseline.id, comparison: newest.id }
}

/** "a@contoso.com, b@contoso.com" as address recipients; groups are kept as they are. */
export function parseAddresses(text: string): Recipient[] {
  return text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((address) => ({ type: "address" as const, address }))
}

export function recipientText(recipients: Recipient[]): string {
  return recipients.filter((recipient) => recipient.type === "address").map((recipient) => (recipient as { address: string }).address).join(", ")
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "Never"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
