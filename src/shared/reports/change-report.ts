import type { AuditChange, AuditChangeType } from "../notifications/audit"
import type { Drift, DriftBackupRef, DriftChange, DriftResult, SettingNames } from "../intune/drift"
import { formatValue, settingLabel } from "../intune/drift-format"
import { redactText } from "../compliance/export"

/**
 * Change reports: what changed in a tenant between two backups, setting by setting, with who
 * changed it and when from the Intune and Entra audit logs. Built in the main process from a drift
 * comparison and the audit events of the same window, then saved, exported (PDF, Markdown, JSON)
 * or sent by email. Everything here is pure, so the same report reads the same in every format.
 */

export const CHANGE_REPORT_SCHEMA = 1

/** Settings listed per item; the rest is counted. */
export const MAX_REPORT_SETTINGS = 300
/** Audit activity lines that match no item. */
export const MAX_OTHER_ACTIVITY = 100
/** Characters of one value. */
export const MAX_VALUE_LENGTH = 600

export type ReportChange = "added" | "modified" | "deleted"
export type ReportSeverity = Drift["severity"]

export interface ReportSetting {
  /** Readable name, such as "Defender: Allow cloud protection". */
  name: string
  /** The property path the name was made from. */
  path: string
  /** "Not set" when the setting did not exist on that side; null when values are left out. */
  before: string | null
  after: string | null
}

export interface ReportActivity {
  at: string
  change: AuditChangeType
  /** User principal name or application name; null when unknown or when actors are left out. */
  who: string | null
  activity: string
  /** The object the event names, for activity that matches no item. */
  target?: string
  /** "Intune" or "Conditional Access". */
  source: string
}

export interface ReportItem {
  change: ReportChange
  /** Item type, such as "Settings Catalog policy". */
  type: string
  name: string
  previousName?: string
  /** Intune or Entra object ID. */
  id: string
  severity: ReportSeverity
  /** Changed settings for modified items; every setting for added and deleted ones. */
  settings: ReportSetting[]
  /** Settings not listed because of MAX_REPORT_SETTINGS. */
  moreSettings: number
  /** Audit events about this item inside the report window, oldest first. */
  activity: ReportActivity[]
  /** The backup that still holds the deleted or previous version. */
  restoreFrom?: string
  likelyRestoredCopy?: boolean
}

export interface ReportSummary {
  added: number
  modified: number
  deleted: number
  critical: number
  /** Changes with at least one audit event naming who made them. */
  attributed: number
}

export interface ChangeReport {
  schemaVersion: typeof CHANGE_REPORT_SCHEMA
  tenantId: string
  tenantName: string
  generatedAt: string
  /** How the report was started. */
  trigger: "manual" | "scheduled"
  from: DriftBackupRef
  to: DriftBackupRef
  summary: ReportSummary
  items: ReportItem[]
  /** Audit events in the window that matched no backed-up item, such as changes made and undone between the backups. */
  otherActivity: ReportActivity[]
  moreActivity: number
  audit: {
    /** "included" when the audit log was read; "unavailable" when it could not be, with the reason. */
    status: "included" | "unavailable"
    note: string | null
    /** Whether actor names are shown. */
    actors: boolean
  }
  /** Whether setting values are shown; off for reports sent where values must not go. */
  values: boolean
  /** Files left out of the comparison. */
  warnings: string[]
}

export interface ReportOptions {
  tenantId: string
  tenantName: string
  generatedAt: string
  trigger: ChangeReport["trigger"]
  includeValues: boolean
  includeActors: boolean
}

/** Audit input: the events of the window, or why they could not be read. */
export type ReportAudit = { changes: Array<AuditChange & { source: string }>; /** A source that could not be read, such as Conditional Access without AuditLog.Read.All. */ note?: string | null } | { error: string }

// Properties a documented item shows elsewhere (its name and type) or that describe the read, not the configuration.
const SKIPPED_DOCUMENTED = /^(?:@odata\.type|displayName|name|settingCount|isAssigned|creationSource|supportsScopeTags|roleScopeTagIds(?:\[.*\])?)$/

const ORDER: Record<ReportChange, number> = { deleted: 0, modified: 1, added: 2 }
const SEVERITY_ORDER: Record<ReportSeverity, number> = { critical: 0, warning: 1, info: 2 }

/** The report for one drift comparison and the audit events between its two backups. */
export function buildChangeReport(drift: DriftResult, audit: ReportAudit, options: ReportOptions): ChangeReport {
  const events = "changes" in audit ? [...audit.changes].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) : []
  const used = new Set<string>()
  const items = drift.drifts.map((entry): ReportItem => {
    const ids = new Set([entry.configId.toLowerCase()].filter(Boolean))
    const names = new Set([entry.configName, entry.previousName].filter((name): name is string => Boolean(name)).map((name) => name.toLowerCase()))
    const matching = events.filter((event) => {
      const byId = !!event.resourceId && ids.has(event.resourceId.toLowerCase())
      // A name match only when the event names no ID at all, so two items sharing a name are not mixed up.
      const byName = !event.resourceId && event.resourceName !== null && names.has(event.resourceName.toLowerCase())
      return byId || byName
    })
    for (const event of matching) used.add(event.auditId)
    const settings = (entry.changes ?? [])
      .filter((change) => entry.changeType === "modified" || !SKIPPED_DOCUMENTED.test(change.field))
      .map((change) => reportSetting(change, entry.changeType, drift.settingNames, options.includeValues))
    return {
      change: entry.changeType,
      type: entry.type,
      name: entry.configName,
      ...(entry.previousName ? { previousName: entry.previousName } : {}),
      id: entry.configId,
      severity: entry.severity,
      settings: settings.slice(0, MAX_REPORT_SETTINGS),
      moreSettings: Math.max(0, settings.length - MAX_REPORT_SETTINGS),
      activity: matching.map((event) => activityOf(event, options.includeActors)),
      ...(entry.changeType !== "added" ? { restoreFrom: entry.fromBackup } : {}),
      ...(entry.likelyRestoredCopy ? { likelyRestoredCopy: true } : {}),
    }
  })
  items.sort((a, b) => ORDER[a.change] - ORDER[b.change] || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  const other = events.filter((event) => !used.has(event.auditId)).map((event) => ({ ...activityOf(event, options.includeActors), target: event.resourceName ?? event.resourceType ?? event.category }))
  return {
    schemaVersion: CHANGE_REPORT_SCHEMA,
    tenantId: options.tenantId.toLowerCase(),
    tenantName: options.tenantName,
    generatedAt: options.generatedAt,
    trigger: options.trigger,
    from: drift.baseline,
    to: drift.comparison,
    summary: {
      added: items.filter((item) => item.change === "added").length,
      modified: items.filter((item) => item.change === "modified").length,
      deleted: items.filter((item) => item.change === "deleted").length,
      critical: items.filter((item) => item.severity === "critical").length,
      attributed: items.filter((item) => item.activity.length > 0).length,
    },
    items,
    otherActivity: other.slice(-MAX_OTHER_ACTIVITY),
    moreActivity: Math.max(0, other.length - MAX_OTHER_ACTIVITY),
    audit: { status: "changes" in audit ? "included" : "unavailable", note: publicAuditNote("error" in audit ? audit.error : audit.note), actors: options.includeActors },
    values: options.includeValues,
    warnings: drift.warnings.slice(0, 50).map((warning) => `${warning.file} (${warning.backup}): ${warning.message}`),
  }
}

function activityOf(event: AuditChange & { source: string }, includeActors: boolean): ReportActivity {
  return {
    at: event.at,
    change: event.changeType,
    who: includeActors ? event.actorUpn ?? event.actorAppName ?? null : null,
    activity: event.activity,
    source: event.source,
  }
}

function reportSetting(change: DriftChange, kind: ReportChange, names: SettingNames | undefined, includeValues: boolean): ReportSetting {
  const label = settingLabel(change, names)
  const value = (input: unknown) => (includeValues ? describeValue(change.field, input, label.definitionId, names, label.property) : null)
  // A documented item has only one side; the other is "Not set" by construction.
  return {
    name: label.label,
    path: change.field,
    before: kind === "added" ? null : value(change.oldValue),
    after: kind === "deleted" ? null : value(change.newValue),
  }
}

const TARGETS: Record<string, string> = {
  "#microsoft.graph.groupAssignmentTarget": "Included group",
  "#microsoft.graph.exclusionGroupAssignmentTarget": "Excluded group",
  "#microsoft.graph.allDevicesAssignmentTarget": "All devices",
  "#microsoft.graph.allLicensedUsersAssignmentTarget": "All users",
  "#microsoft.graph.allUsersAssignmentTarget": "All users",
}

/** An assignment as one line: "Included group 1f2e... (filter include 9a8b...)". */
export function describeAssignment(value: unknown): string | null {
  const target = (value as { target?: Record<string, unknown> } | null)?.target
  if (!target || typeof target !== "object") return null
  const kind = typeof target["@odata.type"] === "string" ? TARGETS[target["@odata.type"]] ?? String(target["@odata.type"]).replace(/^#microsoft\.graph\./, "") : "Assignment"
  const group = typeof target.groupId === "string" ? ` ${target.groupId}` : ""
  const filterType = target.deviceAndAppManagementAssignmentFilterType
  const filterId = target.deviceAndAppManagementAssignmentFilterId
  const filter = typeof filterId === "string" && filterId && filterType !== "none" ? ` (filter ${String(filterType ?? "")} ${filterId})`.replace("  ", " ") : ""
  return `${kind}${group}${filter}`
}

/** One readable value: the choice label, the simple value, an assignment line, or compact JSON. */
export function describeValue(field: string, value: unknown, definitionId?: string, names?: SettingNames, property?: string): string {
  if (/^assignments\[/.test(field) && value && typeof value === "object") {
    const line = describeAssignment(value)
    if (line) return line
  }
  if (value && typeof value === "object") {
    const identifier = (value as { mobileAppIdentifier?: Record<string, unknown> }).mobileAppIdentifier ?? (value as Record<string, unknown>)
    const app = identifier?.packageId ?? identifier?.bundleId
    if (typeof app === "string" && app) return clip(app)
  }
  if (/omaSettings\[[^\]]+\]$/.test(field) && value && typeof value === "object") {
    const oma = value as { value?: unknown; omaUri?: unknown }
    return clip(`${typeof oma.omaUri === "string" ? `${oma.omaUri} = ` : ""}${typeof oma.value === "string" || typeof oma.value === "number" || typeof oma.value === "boolean" ? String(oma.value) : JSON.stringify(oma.value ?? null)}`)
  }
  const formatted = formatValue(value, definitionId, names, property)
  if (formatted.kind !== "json") return clip(formatted.text)
  // "Defender: Allow cloud protection = Allowed" names the setting again; the row already does.
  if (formatted.summary) return clip(formatted.summary.includes(" = ") ? formatted.summary.slice(formatted.summary.indexOf(" = ") + 3) : formatted.summary)
  return clip(JSON.stringify(value))
}

const clip = (text: string) => (text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 3)}...` : text)

/**
 * An audit note fit to show and send: reports are emailed outside the organization, so a raw
 * Microsoft Graph error (proxy URLs, tenant IDs, the request filter) never belongs in one.
 * Notes written by current code are already plain sentences and pass through; a stored raw
 * error is replaced by what it means and what to do about it.
 */
export function publicAuditNote(note: string | null | undefined): string | null {
  if (!note) return null
  const text = note.replace(/\s+/g, " ").trim()
  if (!text) return null
  const raw = text.length > 280 || /https?:\/\/|Operation ID|"_version"|[{[]/.test(text)
  if (!raw) return text
  if (/\b429\b|throttl/i.test(text)) return "Microsoft Graph throttled the audit log request (429). Generate the report again in a few minutes."
  const status = /\breturned (\d{3})\b/.exec(text)?.[1]
  const cleaned = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim()
  if (/^[{[]/.test(cleaned) || /Operation ID|"_version"/.test(cleaned)) return status ? `Microsoft Graph returned ${status}.` : "The audit log could not be read."
  return cleaned.length > 240 ? `${cleaned.slice(0, 237).trimEnd()}...` : cleaned
}

const CHANGE_LABELS: Record<ReportChange, string> = { added: "Added", modified: "Changed", deleted: "Deleted" }
export const changeLabel = (change: ReportChange) => CHANGE_LABELS[change]

/** "6 Nov 2026, 07:00 UTC": reports name UTC so they read the same wherever they are opened. */
export function reportTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

/** "Changes in Contoso, 5 Nov 2026 to 6 Nov 2026". */
export function reportTitle(report: Pick<ChangeReport, "tenantName" | "from" | "to">): string {
  const day = (iso: string) => reportTime(iso).replace(/, \d{2}:\d{2} UTC$/, "")
  const from = day(report.from.timestamp)
  const to = day(report.to.timestamp)
  return `Changes in ${report.tenantName}, ${from === to ? from : `${from} to ${to}`}`
}

/** One sentence: "3 changed, 1 added, 1 deleted; 4 of 5 with who made them." */
export function summaryLine(report: Pick<ChangeReport, "summary" | "audit" | "items">): string {
  const { added, modified, deleted, attributed } = report.summary
  const total = added + modified + deleted
  if (total === 0) return "No changes between the two backups."
  const parts = [modified && `${modified} changed`, added && `${added} added`, deleted && `${deleted} deleted`].filter(Boolean).join(", ")
  if (report.audit.status !== "included") return `${parts}. Who made them is unknown: the audit log could not be read.`
  return `${parts}; ${attributed} of ${total} with matching audit events.`
}

/** "change-report-contoso-2026-11-06" without an extension. */
export function reportFileName(report: Pick<ChangeReport, "tenantName" | "to">): string {
  const slug = report.tenantName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return ["change-report", slug, report.to.timestamp.slice(0, 10)].filter(Boolean).join("-")
}

// ------------------------------------------------------------------------------------------ Markdown

/** Escapes text for a Markdown table cell or line: no HTML, no table breaks, no links. */
export function markdownText(value: string): string {
  return redactText(value)
    .replace(/\r?\n/g, " ")
    .replace(/[\\`*_{}[\]()#+!|<>~]/g, (char) => `\\${char}`)
}

/** The report as Markdown, for a wiki, a Git repository or another tool to read. */
export function changeReportMarkdown(report: ChangeReport): string {
  const lines: string[] = []
  const md = markdownText
  lines.push(`# ${md(reportTitle(report))}`, "")
  lines.push(`- Tenant: ${md(report.tenantName)} (${report.tenantId})`)
  lines.push(`- From backup: ${report.from.id} (${reportTime(report.from.timestamp)})`)
  lines.push(`- To backup: ${report.to.id} (${reportTime(report.to.timestamp)})`)
  lines.push(`- Generated: ${reportTime(report.generatedAt)}${report.trigger === "scheduled" ? " after a scheduled backup" : ""}`)
  lines.push(`- Summary: ${md(summaryLine(report))}`)
  const auditNote = publicAuditNote(report.audit.note)
  if (auditNote) lines.push(`- Audit log: ${md(auditNote)}`)
  if (!report.values) lines.push("- Setting values are left out of this report.")
  lines.push("")
  if (report.items.length === 0) lines.push("No items were added, changed or deleted between the two backups.", "")
  for (const change of ["deleted", "modified", "added"] as const) {
    const items = report.items.filter((item) => item.change === change)
    if (!items.length) continue
    lines.push(`## ${CHANGE_LABELS[change]} (${items.length})`, "")
    for (const item of items) {
      lines.push(`### ${md(item.name)}`, "")
      lines.push(`- Type: ${md(item.type)}`)
      if (item.previousName) lines.push(`- Previously named: ${md(item.previousName)}`)
      lines.push(`- Severity: ${item.severity}`)
      if (item.id) lines.push(`- ID: ${md(item.id)}`)
      if (item.restoreFrom) lines.push(`- Previous version in backup: ${item.restoreFrom}`)
      if (item.likelyRestoredCopy) lines.push("- Likely a copy made by a restore")
      for (const event of item.activity) lines.push(`- ${md(activityLine(event))}`)
      if (!item.activity.length && report.audit.status === "included") lines.push("- No matching audit event in this window")
      lines.push("")
      if (item.settings.length) {
        if (!report.values) {
          lines.push("| Setting |", "| --- |", ...item.settings.map((setting) => `| ${md(setting.name)} |`))
        } else if (change === "modified") {
          lines.push("| Setting | Before | After |", "| --- | --- | --- |", ...item.settings.map((setting) => `| ${md(setting.name)} | ${md(setting.before ?? "")} | ${md(setting.after ?? "")} |`))
        } else {
          lines.push("| Setting | Value |", "| --- | --- |", ...item.settings.map((setting) => `| ${md(setting.name)} | ${md((change === "added" ? setting.after : setting.before) ?? "")} |`))
        }
        if (item.moreSettings) lines.push("", `${item.moreSettings} more settings are not listed.`)
        lines.push("")
      }
    }
  }
  if (report.otherActivity.length) {
    lines.push(`## Other activity (${report.otherActivity.length + report.moreActivity})`, "")
    lines.push("Audit events in this window that match no item in the report, for example a change that was undone before the second backup.", "")
    lines.push("| When | What | Object | Who |", "| --- | --- | --- | --- |")
    for (const event of report.otherActivity) lines.push(`| ${reportTime(event.at)} | ${md(`${event.source}: ${event.activity}`)} | ${md(event.target ?? "")} | ${md(event.who ?? "")} |`)
    if (report.moreActivity) lines.push("", `${report.moreActivity} older events are not listed.`)
    lines.push("")
  }
  if (report.warnings.length) {
    lines.push("## Not compared", "", ...report.warnings.map((warning) => `- ${md(warning)}`), "")
  }
  return `${lines.join("\n").trimEnd()}\n`
}

/** "Updated by admin@contoso.com, 6 Nov 2026, 14:02 UTC (Intune: Patch DeviceConfiguration)". */
export function activityLine(event: ReportActivity): string {
  const verb = event.change.charAt(0).toUpperCase() + event.change.slice(1)
  return `${verb}${event.who ? ` by ${event.who}` : ""}, ${reportTime(event.at)} (${event.source}: ${event.activity})`
}

/** The report as JSON, as stored. */
export function changeReportJson(report: ChangeReport): string {
  return JSON.stringify(report, null, 2)
}
