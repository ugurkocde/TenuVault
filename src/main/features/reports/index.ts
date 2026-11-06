import type { RouteModule } from "../../api/host"
import { allows } from "../../../shared/plans"
import { AuditEventType } from "../../../portal/lib/audit/types"
import { AUDIT_EVENT_SELECT, mapAuditEvent, type AuditChange, type AuditEventRaw } from "../../../shared/notifications/audit"
import { ENTRA_AUDIT_FILTER, ENTRA_AUDIT_SELECT, mapEntraAuditEvent, type EntraAuditRaw } from "../../../shared/notifications/entra"
import { buildEnvelope } from "../../../shared/notifications/envelope"
import { emailHtml, emailSubject } from "../../../shared/notifications/render"
import type { DriftResult } from "../../../shared/intune/drift"
import { isBackupName } from "../../../shared/intune/backup-names"
import {
  buildChangeReport,
  changeReportJson,
  changeReportMarkdown,
  reportFileName,
  reportTitle,
  summaryLine,
  type ChangeReport,
  type ReportAudit,
} from "../../../shared/reports/change-report"
import { buildChangeReportDocument } from "../../../shared/reports/change-report-html"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { recordGovernanceAudit } from "../governance-audit"
import { featureRoute, FeatureError, type Body } from "../route"
import { parseRecipients, type EmailRecipient } from "../notifications/model"
import { graphError, nextPath, resolveRecipients } from "../notifications/service"

/** Reports kept per tenant; the oldest are dropped first. */
export const MAX_REPORTS = 12
/** Audit events read for one report, across both logs. */
export const MAX_AUDIT_EVENTS = 2000
/**
 * Largest attachment sent inline with Microsoft Graph sendMail, whose whole request is capped at
 * 4 MB; base64 adds a third. A larger PDF is replaced by the Markdown, or left out with a note.
 */
export const MAX_ATTACHMENT_BYTES = 2_500_000

export type AttachmentFormat = "pdf" | "markdown"

export interface ReportSettingsRecord {
  title: string
  status: "enabled" | "disabled"
  summary: string
  recipients: EmailRecipient[]
  /** Generate and send a report after every successful scheduled backup. */
  afterScheduledBackup: boolean
  /** Send nothing when a scheduled report found no changes. */
  skipEmpty: boolean
  includeValues: boolean
  includeActors: boolean
  attachment: AttachmentFormat
  lastAutomatic: { at: string; backup: string | null; outcome: "sent" | "skipped" | "failed"; message: string; reportId: string | null } | null
}

export interface SendResult {
  at: string
  ok: boolean
  recipients: number
  attachment: AttachmentFormat | null
  error: string | null
  automatic: boolean
}

export interface ReportRecord {
  title: string
  status: "ready"
  summary: string
  report: ChangeReport
  sends: SendResult[]
}

const DEFAULT_SETTINGS: ReportSettingsRecord = {
  title: "Change report settings",
  status: "disabled",
  summary: "Change reports are generated on demand.",
  recipients: [],
  afterScheduledBackup: false,
  skipEmpty: true,
  includeValues: true,
  includeActors: true,
  attachment: "pdf",
  lastAutomatic: null,
}

export const RUNTIME_NOTE =
  "Reports after scheduled backups are made only while TenuVault is running on this computer and you are signed in to the tenant, like the backups themselves. Email is sent as the signed-in admin and needs the optional Mail.Send permission."

export function settingsOf(deps: FeatureDeps, tenantId: string): Stored<ReportSettingsRecord> | null {
  return deps.records.list<ReportSettingsRecord>(DOMAINS.changeReportSettings, tenantId)[0] ?? null
}

function currentSettings(deps: FeatureDeps, tenantId: string): ReportSettingsRecord {
  return { ...DEFAULT_SETTINGS, ...settingsOf(deps, tenantId) }
}

function saveSettings(deps: FeatureDeps, tenantId: string, change: Partial<ReportSettingsRecord>, meta: { actor: string | null; reason: string }): Stored<ReportSettingsRecord> {
  const existing = settingsOf(deps, tenantId)
  const summarize = (value: ReportSettingsRecord) => ({
    ...value,
    status: value.afterScheduledBackup ? "enabled" as const : "disabled" as const,
    summary: value.afterScheduledBackup
      ? `A report is made after every scheduled backup${value.recipients.length ? ` and sent to ${value.recipients.length} ${value.recipients.length === 1 ? "recipient" : "recipients"}` : ""}.`
      : "Change reports are generated on demand.",
  })
  if (!existing) return deps.records.create(DOMAINS.changeReportSettings, tenantId, summarize({ ...DEFAULT_SETTINGS, ...change }), meta)
  return deps.records.update<ReportSettingsRecord>(DOMAINS.changeReportSettings, tenantId, existing.id, (current) => summarize({ ...DEFAULT_SETTINGS, ...current, ...change }), meta)!
}

export function reportsOf(deps: FeatureDeps, tenantId: string): Stored<ReportRecord>[] {
  return deps.records.list<ReportRecord>(DOMAINS.changeReports, tenantId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

function reportOf(deps: FeatureDeps, tenantId: string, body: Body): Stored<ReportRecord> {
  const id = body.reportId
  if (typeof id !== "string" || id.length > 100) throw new FeatureError("reportId is required")
  const record = deps.records.get<ReportRecord>(DOMAINS.changeReports, tenantId, id)
  if (!record) throw new FeatureError("This report is no longer stored on this computer.", 404)
  return record
}

/** A report as the list shows it: no settings, values or audit lines. */
function listed(record: Stored<ReportRecord>) {
  const { report } = record
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    createdAt: record.createdAt,
    trigger: report.trigger,
    from: report.from,
    to: report.to,
    counts: report.summary,
    audit: report.audit.status,
    values: report.values,
    lastSend: record.sends[record.sends.length - 1] ?? null,
  }
}

function publicSettings(settings: ReportSettingsRecord) {
  return {
    recipients: settings.recipients,
    afterScheduledBackup: settings.afterScheduledBackup,
    skipEmpty: settings.skipEmpty,
    includeValues: settings.includeValues,
    includeActors: settings.includeActors,
    attachment: settings.attachment,
    lastAutomatic: settings.lastAutomatic,
  }
}

const bool = (body: Body, key: string): boolean | undefined => (typeof body[key] === "boolean" ? (body[key] as boolean) : undefined)

/** /api/reports: change reports per tenant, generated from two backups and the audit log. */
export function routes(deps: FeatureDeps): Record<string, RouteModule> {
  return featureRoute("/api/reports", deps, {
    "get-status": ({ tenantId, deps, plan }) => ({
      licensed: allows(plan, "changeReports"),
      runtimeNote: RUNTIME_NOTE,
      settings: publicSettings(currentSettings(deps, tenantId)),
      reports: reportsOf(deps, tenantId).map(listed),
    }),

    "get-report": ({ tenantId, body, deps }) => {
      const record = reportOf(deps, tenantId, body)
      return { report: record.report, sends: record.sends }
    },

    // A read: stored reports stay exportable after a downgrade, like other stored evidence.
    "get-export": async ({ tenantId, body, deps }) => {
      const record = reportOf(deps, tenantId, body)
      const format = body.format
      if (format !== "pdf" && format !== "markdown" && format !== "json") throw new FeatureError("format must be pdf, markdown or json")
      const name = reportFileName(record.report)
      if (format === "json") return { fileName: `${name}.json`, data: changeReportJson(record.report), encoding: "utf8" }
      if (format === "markdown") return { fileName: `${name}.md`, data: changeReportMarkdown(record.report), encoding: "utf8" }
      const pdf = await printReport(deps, tenantId, record.report)
      return { fileName: `${name}.pdf`, data: Buffer.from(pdf).toString("base64"), encoding: "base64" }
    },

    generate: async ({ tenantId, body, deps, actor }) => {
      const baseline = optionalBackup(body, "baseline")
      const comparison = optionalBackup(body, "comparison")
      if ((baseline === null) !== (comparison === null)) throw new FeatureError("Choose both backups, or neither for the two newest.")
      const record = await generateReport(deps, tenantId, { baseline, comparison, trigger: "manual", actor })
      return { report: listed(record) }
    },

    send: async ({ tenantId, body, deps, actor }) => {
      const record = reportOf(deps, tenantId, body)
      const settings = currentSettings(deps, tenantId)
      let recipients = settings.recipients
      if (body.recipients !== undefined) {
        const parsed = parseRecipients(body.recipients)
        if (!parsed.ok) throw new FeatureError(parsed.error)
        recipients = parsed.recipients
      }
      if (!recipients.length) throw new FeatureError("Add at least one email recipient.")
      const result = await sendReport(deps, tenantId, record, recipients, settings.attachment, { automatic: false, actor })
      if (!result.ok) throw new FeatureError(result.error ?? "The report could not be sent.", 502)
      return { send: result }
    },

    "save-settings": ({ tenantId, body, deps, actor }) => {
      const change: Partial<ReportSettingsRecord> = {}
      if (body.recipients !== undefined) {
        if (Array.isArray(body.recipients) && body.recipients.length === 0) change.recipients = []
        else {
          const parsed = parseRecipients(body.recipients)
          if (!parsed.ok) throw new FeatureError(parsed.error)
          change.recipients = parsed.recipients
        }
      }
      for (const key of ["afterScheduledBackup", "skipEmpty", "includeValues", "includeActors"] as const) {
        const value = bool(body, key)
        if (value !== undefined) change[key] = value
      }
      if (body.attachment !== undefined) {
        if (body.attachment !== "pdf" && body.attachment !== "markdown") throw new FeatureError("attachment must be pdf or markdown")
        change.attachment = body.attachment
      }
      const saved = saveSettings(deps, tenantId, change, { actor, reason: "Change report settings saved" })
      return { settings: publicSettings(saved) }
    },

    "remove-report": ({ tenantId, body, deps }) => {
      const record = reportOf(deps, tenantId, body)
      deps.records.remove(DOMAINS.changeReports, tenantId, record.id)
      return { removed: record.id }
    },
  })
}

/** Nothing runs on a timer: reports after scheduled backups start from the backup itself (afterScheduledBackup). */
export function start(_deps: FeatureDeps): () => void {
  return () => undefined
}

function optionalBackup(body: Body, key: string): string | null {
  const value = body[key]
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || !isBackupName(value)) throw new FeatureError(`${key} is not a backup name`)
  return value
}

/**
 * Compares two backups (the two newest complete ones without a pair), reads the audit events
 * between them, builds the report and stores it, keeping the newest MAX_REPORTS.
 */
export async function generateReport(
  deps: FeatureDeps,
  tenantId: string,
  /** Both backups, neither (the two newest complete ones), or only the comparison (it and the complete backup before it). */
  input: { baseline: string | null; comparison: string | null; trigger: ChangeReport["trigger"]; actor: string | null },
): Promise<Stored<ReportRecord>> {
  const tenant = tenantId.toLowerCase()
  const profile = deps.tenant(tenant)
  if (!profile) throw new FeatureError("This tenant is not connected.", 404)
  const response = await deps.api("/api/detect-drifts", tenant, {
    ...(input.baseline && input.comparison ? { baseline: input.baseline, comparison: input.comparison } : input.comparison ? { comparison: input.comparison } : {}),
    documentItems: true,
  })
  const body = (await response.json().catch(() => null)) as (DriftResult & { error?: string; code?: string }) | null
  if (!response.ok || !body || !Array.isArray(body.drifts)) {
    const status = response.status === 404 || response.status === 409 ? response.status : 502
    throw new FeatureError(body?.error ?? `The backups could not be compared (${response.status}).`, status)
  }
  const settings = currentSettings(deps, tenant)
  const audit = await readAudit(deps, tenant, body)
  const report = buildChangeReport(body, audit, {
    tenantId: tenant,
    tenantName: profile.name,
    generatedAt: deps.now().toISOString(),
    trigger: input.trigger,
    includeValues: settings.includeValues,
    includeActors: settings.includeActors,
  })
  const created = deps.records.create<ReportRecord>(DOMAINS.changeReports, tenant, {
    title: reportTitle(report),
    status: "ready",
    summary: summaryLine(report),
    report,
    sends: [],
  }, { actor: input.actor, reason: `Change report generated (${input.trigger})` })
  deps.records.prune<ReportRecord>(DOMAINS.changeReports, tenant, MAX_REPORTS, (record) => record.id !== created.id)
  return created
}

const CONDITIONAL_ACCESS_TYPES = /conditional access|named location|authentication strength/i

/**
 * Audit events between the two backups. The Intune audit log is always read; the Entra audit log
 * only when the report holds Conditional Access items, since it needs the optional AuditLog.Read.All.
 * A failed Intune read leaves the whole report without actors; a failed Entra read only those items.
 */
export async function readAudit(deps: FeatureDeps, tenantId: string, drift: Pick<DriftResult, "baseline" | "comparison" | "drifts">): Promise<ReportAudit> {
  const from = new Date(drift.baseline.timestamp).toISOString()
  const to = new Date(drift.comparison.timestamp).toISOString()
  let graph: Awaited<ReturnType<FeatureDeps["graph"]>>
  try {
    graph = await deps.graph(tenantId)
  } catch (error) {
    return { error: `The audit log could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  // No $orderby: with it, Graph scans the whole audit history from the oldest event and answers
  // with empty pages until it reaches the window. The report sorts the events itself.
  const window = (start: string) => `activityDateTime gt ${start} and activityDateTime le ${to}`
  const intune = await readLog(graph, `deviceManagement/auditEvents?$select=${AUDIT_EVENT_SELECT}&$filter=${encodeURIComponent(`${window(from)} and activityOperationType ne 'Get' and activityOperationType ne 'Search'`)}&$top=200`,
    (raw) => mapAuditEvent(raw as AuditEventRaw), "Intune",
    "Microsoft Graph returned 403 for the Intune audit log. Your account needs an Intune role that can read audit logs.")
  if ("error" in intune) return intune
  const notes: string[] = []
  if (intune.incomplete) notes.push(incompleteNote("Intune", intune.incomplete))
  const changes = [...intune.changes]
  if (drift.drifts.some((entry) => CONDITIONAL_ACCESS_TYPES.test(entry.type))) {
    const entraPath = (start: string) => `auditLogs/directoryAudits?$select=${ENTRA_AUDIT_SELECT}&$filter=${encodeURIComponent(`${ENTRA_AUDIT_FILTER} and ${window(start)}`)}&$top=200`
    const entraMap = (raw: Record<string, unknown>) => mapEntraAuditEvent(raw as EntraAuditRaw)
    const denied = "Conditional Access changes have no actors: reading the Entra audit log needs the delegated AuditLog.Read.All permission and a role such as Security Reader."
    let entra = await readLog(graph, entraPath(from), entraMap, "Conditional Access", denied)
    // Entra keeps audit events for 7 or 30 days and refuses an older start; read what it still keeps.
    const kept = "error" in entra ? retentionStart(entra.error) : null
    if (kept && kept > from && kept < to) {
      entra = await readLog(graph, entraPath(kept), entraMap, "Conditional Access", denied)
      if (!("error" in entra)) notes.push(`Entra keeps Conditional Access audit events only since ${kept.slice(0, 10)}, so earlier Conditional Access changes have no actors.`)
    }
    if ("error" in entra) notes.push(entra.error)
    else {
      changes.push(...entra.changes)
      if (entra.incomplete) notes.push(incompleteNote("Conditional Access", entra.incomplete))
    }
  }
  return { changes, note: notes.length ? notes.join(" ") : null }
}

/** Pages one audit log read follows; Graph can answer with empty pages while it moves through its partitions. */
export const MAX_AUDIT_PAGES = 200

function incompleteNote(source: string, reason: "events" | "pages"): string {
  return reason === "events"
    ? `More than ${MAX_AUDIT_EVENTS} ${source} audit events in this window; not all of them were read, so some changes may have no actors.`
    : `The ${source} audit log was not read to the end of this window, so some changes may have no actors.`
}

/** The oldest start Entra accepts, from its "Minimum allowed time for activityDateTime is ..." refusal, as an ISO time. */
export function retentionStart(error: string): string | null {
  const match = /Minimum allowed time for activityDateTime is ([0-9/]+ [0-9:]+ [AP]M)/.exec(error)
  if (!match) return null
  const parsed = Date.parse(`${match[1]} UTC`)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

async function readLog(
  graph: Awaited<ReturnType<FeatureDeps["graph"]>>,
  first: string,
  map: (raw: Record<string, unknown>) => AuditChange | null,
  source: string,
  denied: string,
): Promise<{ changes: Array<AuditChange & { source: string }>; incomplete: "events" | "pages" | null } | { error: string }> {
  const changes: Array<AuditChange & { source: string }> = []
  let path: string | null = first
  let pages = 0
  try {
    while (path && pages < MAX_AUDIT_PAGES && changes.length <= MAX_AUDIT_EVENTS) {
      pages++
      const response: { status: number; body: Record<string, unknown> } = await graph("GET", path)
      if (response.status === 403) return { error: denied }
      if (response.status !== 200) return { error: `The ${source} audit log could not be read: ${graphError(response.body, response.status)}` }
      for (const raw of Array.isArray(response.body.value) ? (response.body.value as Array<Record<string, unknown>>) : []) {
        const change = map(raw)
        if (change) changes.push({ ...change, source })
      }
      path = nextPath(response.body)
    }
  } catch (error) {
    return { error: `The ${source} audit log could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  const incomplete = changes.length > MAX_AUDIT_EVENTS ? "events" : path ? "pages" : null
  // Unordered pages: the oldest events are kept, so the report still names who started the changes.
  const kept = changes.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, MAX_AUDIT_EVENTS)
  return { changes: kept, incomplete }
}

async function printReport(deps: FeatureDeps, tenantId: string, report: ChangeReport): Promise<Uint8Array> {
  if (!deps.printPdf) throw new FeatureError("PDF reports cannot be printed here.", 501)
  const branding = await deps.pdfBranding?.(tenantId)
  const document = buildChangeReportDocument(report, { branding })
  const pdf = await deps.printPdf(document.html, document.print)
  if (Buffer.from(pdf).subarray(0, 5).toString("latin1") !== "%PDF-") throw new FeatureError("The PDF report could not be printed.", 500)
  return pdf
}

/** The email: a summary with the first changes, in the design of notification email, and the report attached. */
export function reportEmail(record: Pick<ReportRecord, "report">, attachmentNote: string | null) {
  const { report } = record
  const severity = report.summary.deleted > 0 || report.summary.critical > 0 ? "warning" as const : "info" as const
  const verbs = { added: "Created", modified: "Changed", deleted: "Deleted" } as const
  const envelope = buildEnvelope({
    type: "drift.detected",
    severity,
    tenantId: report.tenantId,
    tenantName: report.tenantName,
    occurredAt: report.generatedAt,
    naturalKey: `report:${report.from.id}:${report.to.id}:${report.generatedAt}`,
    title: reportTitle(report),
    summary: `${summaryLine(report)}${attachmentNote ? ` ${attachmentNote}` : ""}`,
    details: [
      { label: "From backup", value: report.from.id },
      { label: "To backup", value: report.to.id },
      { label: "Changed", value: String(report.summary.modified) },
      { label: "Added", value: String(report.summary.added) },
      { label: "Deleted", value: String(report.summary.deleted) },
    ],
    items: report.items.slice(0, 20).map((item) => ({
      title: `${verbs[item.change]}: ${item.name}`,
      detail: `${item.type}${item.settings.length ? `, ${item.settings.length + item.moreSettings} ${item.change === "modified" ? "changed " : ""}${item.settings.length + item.moreSettings === 1 ? "setting" : "settings"}` : ""}`,
      ...(item.activity[0]?.who ? { actor: item.activity[0].who } : {}),
      ...(item.activity[0] ? { at: item.activity[0].at } : {}),
    })),
    moreCount: Math.max(0, report.items.length - 20),
    source: "desktop",
  })
  return { subject: emailSubject(envelope), html: emailHtml(envelope) }
}

/**
 * Sends a stored report by email as the signed-in admin (Graph sendMail, delegated Mail.Send),
 * with the PDF or Markdown attached when it fits a single request. The result is recorded on
 * the report and in the tenant's audit log. Never throws; failures are returned.
 */
export async function sendReport(
  deps: FeatureDeps,
  tenantId: string,
  record: Stored<ReportRecord>,
  recipients: EmailRecipient[],
  preferred: AttachmentFormat,
  options: { automatic: boolean; actor: string | null },
): Promise<SendResult> {
  const at = deps.now().toISOString()
  const name = reportFileName(record.report)
  let result: SendResult
  try {
    const graph = await deps.graph(tenantId)
    const resolved = await resolveRecipients(graph, { recipients })
    if ("error" in resolved) {
      result = { at, ok: false, recipients: 0, attachment: null, error: resolved.error, automatic: options.automatic }
    } else {
      const candidates: Array<{ format: AttachmentFormat; file: () => Promise<{ name: string; type: string; bytes: Buffer }> }> = [
        ...(preferred === "pdf" ? [{ format: "pdf" as const, file: async () => ({ name: `${name}.pdf`, type: "application/pdf", bytes: Buffer.from(await printReport(deps, tenantId, record.report)) }) }] : []),
        { format: "markdown" as const, file: async () => ({ name: `${name}.md`, type: "text/markdown", bytes: Buffer.from(changeReportMarkdown(record.report), "utf8") }) },
      ]
      let attachment: { format: AttachmentFormat; name: string; type: string; bytes: Buffer } | null = null
      let printError: string | null = null
      for (const candidate of candidates) {
        try {
          const file = await candidate.file()
          if (file.bytes.length <= MAX_ATTACHMENT_BYTES) {
            attachment = { format: candidate.format, ...file }
            break
          }
        } catch (error) {
          printError = error instanceof Error ? error.message : String(error)
        }
      }
      // The note reaches recipients, possibly outside the organization: it states the reason, never the raw error.
      if (printError) console.warn("[reports] The PDF report could not be printed for email:", printError)
      const note = attachment
        ? attachment.format !== preferred
          ? printError ? "The PDF could not be created, so the report is attached as Markdown." : "The PDF was too large to attach, so the report is attached as Markdown."
          : null
        : "The report could not be attached; open it in TenuVault."
      const email = reportEmail(record, note)
      const message = {
        subject: email.subject,
        body: { contentType: "HTML", content: email.html },
        toRecipients: resolved.addresses.map((address) => ({ emailAddress: { address } })),
        ...(attachment ? { attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: attachment.name, contentType: attachment.type, contentBytes: attachment.bytes.toString("base64") }] } : {}),
      }
      const response = await graph("POST", "me/sendMail", { message, saveToSentItems: true } as unknown as Parameters<typeof graph>[2])
      result = response.status >= 200 && response.status < 300
        ? { at, ok: true, recipients: resolved.addresses.length, attachment: attachment?.format ?? null, error: null, automatic: options.automatic }
        : { at, ok: false, recipients: 0, attachment: null, error: graphError(response.body as Record<string, unknown>, response.status).slice(0, 300), automatic: options.automatic }
    }
  } catch (error) {
    result = { at, ok: false, recipients: 0, attachment: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 300), automatic: options.automatic }
  }
  deps.records.update<ReportRecord>(DOMAINS.changeReports, tenantId, record.id, (current) => ({ ...current, sends: [...current.sends, result].slice(-20) }), {
    actor: options.actor,
    reason: result.ok ? `Change report sent to ${result.recipients} recipients` : `Change report could not be sent: ${result.error}`,
  })
  if (result.ok) {
    await recordGovernanceAudit(deps, tenantId, options.actor, {
      eventType: AuditEventType.REPORT_SENT,
      action: "Send change report",
      resourceId: record.id,
      resourceName: record.title,
      link: "/portal/reports",
      details: { recipients: result.recipients, attachment: result.attachment, automatic: options.automatic, from: record.report.from.id, to: record.report.to.id },
    })
  }
  return result
}

/**
 * After a scheduled backup finished: when the tenant asked for it, compares that backup with the
 * complete backup before it and sends the report. Once per backup; best effort, never throws. A
 * backup that completed with warnings, or the first backup of a tenant, is skipped.
 */
export async function afterScheduledBackup(deps: FeatureDeps, tenantId: string, backupFolder: string | null): Promise<void> {
  const tenant = tenantId.toLowerCase()
  const settings = settingsOf(deps, tenant)
  if (!settings?.afterScheduledBackup || !backupFolder) return
  if (settings.lastAutomatic?.backup === backupFolder) return
  // Recording the outcome is best effort too: a failed write is logged, never thrown into the backup run.
  const remember = (outcome: "sent" | "skipped" | "failed", message: string, reportId: string | null) => {
    try {
      saveSettings(deps, tenant, { lastAutomatic: { at: deps.now().toISOString(), backup: backupFolder, outcome, message: message.slice(0, 300), reportId } }, { actor: null, reason: `Report after scheduled backup ${outcome}` })
    } catch (error) {
      console.warn(`[reports] The outcome of the report after ${backupFolder} could not be recorded (${outcome}):`, error instanceof Error ? error.message : String(error))
    }
  }
  try {
    if (!allows(await deps.plan(tenant), "changeReports")) return
  } catch {
    return
  }
  try {
    // This backup and the complete backup before it, even when another backup finished meanwhile.
    let record: Stored<ReportRecord>
    try {
      record = await generateReport(deps, tenant, { baseline: null, comparison: backupFolder, trigger: "scheduled", actor: null })
    } catch (error) {
      // Completed with warnings, the first backup, or removed by retention: nothing to compare, not a failure.
      if (error instanceof FeatureError && (error.status === 404 || error.status === 409)) return void remember("skipped", error.message, null)
      throw error
    }
    const total = record.report.items.length
    if (!settings.recipients.length) return void remember("skipped", "The report was saved. No recipients are set, so it was not sent.", record.id)
    if (total === 0 && settings.skipEmpty) return void remember("skipped", "Nothing changed, so no report was sent.", record.id)
    const sent = await sendReport(deps, tenant, record, settings.recipients, settings.attachment, { automatic: true, actor: null })
    remember(sent.ok ? "sent" : "failed", sent.ok ? `Sent to ${sent.recipients} ${sent.recipients === 1 ? "recipient" : "recipients"}.` : sent.error ?? "The report could not be sent.", record.id)
  } catch (error) {
    remember("failed", error instanceof Error ? error.message : String(error), null)
  }
}

