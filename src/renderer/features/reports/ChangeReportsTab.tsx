import { PausedOnCommunity } from "../../components/PausedOnCommunity"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, Download, FileJson, FileText, Mail, Play, RefreshCw, Trash2 } from "lucide-react"
import { Chip, Tile } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu"
import { BackupPairPicker } from "~/components/drift/backup-pair-picker"
import { toast } from "../../lib/toast"
import { startBackgroundTask, useBackgroundTask } from "../../lib/background-tasks"
import { useBackupList } from "../../lib/backup-list"
import { Notice, saveFile, useSaveNotice } from "../../components/oib/notices"
import type { FeatureTabProps } from "../types"
import { formatWhen, parseAddresses, PERIOD_LABELS, periodPair, recipientText, reportsApi, type ExportFormat, type ListedReport, type Period, type ReportSettings, type ReportsStatus } from "./api"
import { ReportView } from "./ReportView"

const PERIODS: Period[] = ["previous", "7", "30", "custom"]
const NO_BACKUPS: never[] = []

/**
 * Change reports: what changed between two backups, setting by setting, with who changed it from
 * the audit log, as PDF, Markdown or JSON, sent by email on demand or after every scheduled backup.
 * Without the feature it shows only reports stored earlier, read-only and exportable.
 */
export default function ChangeReportsTab({ tenant, plan, allowed }: FeatureTabProps) {
  const tenantId = tenant.credentials?.tenantId
  const client = useQueryClient()
  const status = useQuery({ queryKey: ["reports-status", tenantId], queryFn: () => reportsApi.status(tenant), enabled: !!tenantId })
  const refresh = () => void client.invalidateQueries({ queryKey: ["reports-status", tenantId] })
  const data = status.data
  const reports = data?.reports ?? []
  const [open, setOpen] = useState<string | null>(null)

  if (!allowed && !data?.settings.afterScheduledBackup && reports.length === 0) return null

  return (
    <div className="space-y-4">
      {plan === "community" && data?.settings.afterScheduledBackup && <PausedOnCommunity />}
      {status.error && <p className="text-sm text-red-700" role="alert">{status.error instanceof Error ? status.error.message : "Reports could not be loaded."}</p>}
      {allowed && <NewReport tenant={tenant} reports={reports} onCreated={(id) => { refresh(); setOpen(id) }} onOpen={setOpen} />}
      <Tile aria-labelledby="reports-list-heading" className="gap-4">
        <div>
          <h3 id="reports-list-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
            <FileText className="h-4 w-4 text-gray-500" aria-hidden="true" />
            Reports
          </h3>
          <p className="text-sm text-gray-600">
            The newest 12 reports of this tenant are kept on this computer.
            {reports.length >= 12 ? " Generating a new one removes the oldest." : ""}
          </p>
        </div>
        {status.isLoading && <div className="h-16 animate-pulse rounded-2xl bg-gray-50" />}
        {!status.isLoading && reports.length === 0 && <p className="text-sm text-gray-600">No reports yet. Generate one above.</p>}
        <ul className="divide-y divide-gray-100">
          {reports.map((report) => (
            <ReportRow
              key={report.id}
              tenant={tenant}
              report={report}
              open={open === report.id}
              onToggle={() => setOpen(open === report.id ? null : report.id)}
              recipients={data?.settings.recipients.length ?? 0}
              readOnly={!allowed}
              onChanged={refresh}
              onRegenerated={(id) => { refresh(); setOpen(id) }}
            />
          ))}
        </ul>
      </Tile>
      {allowed && data && <SettingsPanel tenant={tenant} status={data} onSaved={refresh} />}
    </div>
  )
}

function NewReport({ tenant, reports, onCreated, onOpen }: { tenant: FeatureTabProps["tenant"]; reports: ListedReport[]; onCreated: (id: string) => void; onOpen: (id: string) => void }) {
  const tenantId = tenant.credentials?.tenantId
  const [period, setPeriod] = useState<Period>("previous")
  const list = useBackupList(tenant)
  const backups = list.backups ?? NO_BACKUPS
  const loading = list.loading && list.backups === null
  const [pair, setPair] = useState<{ baseline: string | null; comparison: string | null }>({ baseline: null, comparison: null })
  const preset = period === "custom" ? null : periodPair(backups, period)
  useEffect(() => {
    if (period === "custom" && !pair.baseline && !pair.comparison) {
      const latest = periodPair(backups, "previous")
      if (latest) setPair(latest)
    }
  }, [period, backups])
  const key = tenantId ? `change-report:${tenantId.toLowerCase()}` : undefined
  const task = useBackgroundTask(key)
  const running = task?.status === "running"
  const generate = (chosen: { baseline: string; comparison: string }) => {
    if (!key) return
    startBackgroundTask(key, { title: "Change report", detail: `Comparing backups of ${tenant.name}`, href: "/portal/reports", tenantId }, async () => {
      const result = await reportsApi.generate(tenant, chosen)
      onCreated(result.report.id)
      return result.report.summary
    })
  }
  const describe = (id: string | undefined) => {
    const backup = backups.find((entry) => entry.id === id)
    return backup ? new Date(backup.timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : id ?? ""
  }
  const chosen = period === "custom" ? (pair.baseline && pair.comparison ? { baseline: pair.baseline, comparison: pair.comparison } : null) : preset
  const existing = chosen ? reports.find((report) => report.from.id === chosen.baseline && report.to.id === chosen.comparison) : undefined
  // "Last 7 days" with only three days of backups compares what there is; say so instead of letting the label overpromise.
  const shortHistory = period !== "custom" && period !== "previous" && preset
    ? (() => {
        const from = backups.find((entry) => entry.id === preset.baseline)
        const to = backups.find((entry) => entry.id === preset.comparison)
        return from && to && Date.parse(to.timestamp) - Date.parse(from.timestamp) < Number(period) * 86_400_000
      })()
    : false

  return (
    <Tile aria-labelledby="new-report-heading" className="gap-4">
      <div>
        <h3 id="new-report-heading" className="text-lg font-medium text-gray-900">New change report</h3>
        <p className="max-w-3xl text-sm text-gray-600">
          Names who made each change from the Intune and Entra audit logs. Nothing in the tenant is changed.
        </p>
      </div>
      <div role="radiogroup" aria-label="Report period" className="flex flex-wrap gap-2">
        {PERIODS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={period === candidate}
            onClick={() => setPeriod(candidate)}
            className={`h-9 rounded-full px-4 text-sm font-medium transition-colors ${period === candidate ? "bg-primary text-primary-foreground" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
          >
            {PERIOD_LABELS[candidate]}
          </button>
        ))}
      </div>
      {period === "custom" ? (
        <BackupPairPicker
          backups={backups}
          loading={loading}
          loaded={list.backups !== null}
          baseline={pair.baseline}
          comparison={pair.comparison}
          busy={running}
          latest={periodPair(backups, "previous")}
          onChange={setPair}
          onCompare={() => pair.baseline && pair.comparison && generate({ baseline: pair.baseline, comparison: pair.comparison })}
          actionLabel={existing ? "Regenerate report" : "Generate report"}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => preset && generate(preset)} disabled={running || !preset}>
            <Play className="h-4 w-4" aria-hidden="true" />
            {running ? "Generating in background" : existing ? "Regenerate report" : "Generate report"}
          </Button>
          {loading ? (
            <p className="text-sm text-gray-600">Loading backups...</p>
          ) : preset ? (
            <p className="text-sm text-gray-600">
              {`From ${describe(preset.baseline)} to ${describe(preset.comparison)}`}
              {shortHistory ? " (all the backup history there is)" : ""}
            </p>
          ) : (
            <p className="text-sm text-gray-600">
              Two complete backups are needed.{" "}
              <Link to="/portal/backup" className="font-medium text-gray-900 underline underline-offset-2">Run a backup first</Link>
            </p>
          )}
        </div>
      )}
      {existing && !running && (
        <p className="text-sm text-gray-600">
          A report for these two backups already exists.{" "}
          <button type="button" onClick={() => onOpen(existing.id)} className="font-medium text-gray-900 underline underline-offset-2">Open it</button>
          {" "}instead of generating it again.
        </p>
      )}
      {task?.status === "failed" && task.error && <p role="alert" className="text-sm text-red-700">{task.error}</p>}
    </Tile>
  )
}

/** Export stays with the report it acts on, both on the collapsed row and in the expanded action bar. */
function ReportExportMenu({ reportTitle, saving, onExport }: { reportTitle: string; saving: boolean; onExport: (format: ExportFormat) => void }) {
  const [open, setOpen] = useState(false)
  const item = (format: ExportFormat, label: string, Icon: typeof FileText) => (
    <DropdownMenuItem disabled={saving} onSelect={() => { if (!saving) onExport(format) }} className="gap-2">
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </DropdownMenuItem>
  )
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={(nextOpen) => { if (!nextOpen || !saving) setOpen(nextOpen) }}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-disabled={saving || undefined} aria-busy={saving || undefined} className={saving ? "opacity-50" : undefined} aria-label={`Export ${reportTitle}`}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Export
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {item("pdf", "PDF report", FileText)}
        {item("markdown", "Markdown", FileText)}
        {item("json", "JSON", FileJson)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ReportRow({ tenant, report, open, onToggle, recipients, readOnly, onChanged, onRegenerated }: {
  tenant: FeatureTabProps["tenant"]
  report: ListedReport
  open: boolean
  onToggle: () => void
  recipients: number
  readOnly: boolean
  onChanged: () => void
  onRegenerated: (id: string) => void
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const tenantId = tenant.credentials?.tenantId
  const regenKey = tenantId ? `change-report:${tenantId.toLowerCase()}` : undefined
  const regenTask = useBackgroundTask(regenKey)
  const regenerating = regenTask?.status === "running"
  const regenerate = () => {
    if (!regenKey) return
    startBackgroundTask(regenKey, { title: "Change report", detail: `Comparing backups of ${tenant.name}`, href: "/portal/reports", tenantId }, async () => {
      const result = await reportsApi.generate(tenant, { baseline: report.from.id, comparison: report.to.id })
      onRegenerated(result.report.id)
      return result.report.summary
    })
  }
  const jumpToRecipients = () => {
    document.getElementById("report-email-settings")?.scrollIntoView({ behavior: "smooth", block: "start" })
    document.getElementById("report-recipients")?.focus({ preventScroll: true })
  }
  const detail = useQuery({ queryKey: ["report", tenant.credentials?.tenantId, report.id], queryFn: () => reportsApi.report(tenant, report.id), enabled: open })
  const notice = useSaveNotice()
  const save = (format: ExportFormat) =>
    void notice.save(async () => {
      const file = await reportsApi.exportFile(tenant, report.id, format)
      return saveFile(file.data, file.fileName, file.encoding)
    })
  const send = useMutation({
    mutationFn: () => reportsApi.send(tenant, report.id),
    onSuccess: (result) => toast(`Report sent to ${result.send.recipients} ${result.send.recipients === 1 ? "recipient" : "recipients"}.`, "success"),
    onError: (error) => toast(error instanceof Error ? error.message : "The report could not be sent.", "error"),
    onSettled: onChanged,
  })
  const remove = useMutation({
    mutationFn: () => reportsApi.remove(tenant, report.id),
    onError: (error) => toast(error instanceof Error ? error.message : "The report could not be removed.", "error"),
    onSettled: onChanged,
  })
  const { counts } = report
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Chevron className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block break-words font-medium text-gray-900">{report.title}</span>
            <span className="block text-xs text-gray-500">
              {formatWhen(report.createdAt)}
              {report.trigger === "scheduled" ? ", after a scheduled backup" : ""}
              {report.lastSend ? `. ${report.lastSend.ok ? `Sent to ${report.lastSend.recipients} ${report.lastSend.recipients === 1 ? "recipient" : "recipients"} ${formatWhen(report.lastSend.at)}` : `Sending failed: ${report.lastSend.error ?? "unknown error"}`}` : ""}
            </span>
          </span>
        </button>
        <span className="flex flex-wrap gap-1.5">
          {counts.modified > 0 && <Chip tone="warning">{counts.modified} changed</Chip>}
          {counts.added > 0 && <Chip tone="success">{counts.added} added</Chip>}
          {counts.deleted > 0 && <Chip tone="danger">{counts.deleted} deleted</Chip>}
          {counts.modified + counts.added + counts.deleted === 0 && <Chip>No changes</Chip>}
          {report.audit !== "included" && <Chip tone="warning">Audit log not read</Chip>}
        </span>
        {!open && <ReportExportMenu reportTitle={report.title} saving={notice.saving} onExport={save} />}
      </div>
      {!open && notice.result && (
        <div className="mt-3 pl-6">
          <Notice result={notice.result} onDismiss={notice.clear} />
        </div>
      )}
      {open && (
        <div className="mt-4 space-y-4 pl-6">
          <div role="group" aria-label="Report actions" className="sticky top-3 z-20 flex flex-wrap items-center gap-2 rounded-3xl border border-gray-100 bg-white/95 p-2 shadow-sm backdrop-blur">
            <ReportExportMenu reportTitle={report.title} saving={notice.saving} onExport={save} />
            {!readOnly && recipients > 0 && (
              <Button type="button" variant="outline" size="sm" disabled={send.isPending} onClick={() => send.mutate()}>
                <Mail className="h-4 w-4" aria-hidden="true" />
                {send.isPending ? "Sending" : "Send by email"}
              </Button>
            )}
            {!readOnly && report.audit !== "included" && (
              <Button type="button" variant="outline" size="sm" disabled={regenerating} onClick={regenerate}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {regenerating ? "Generating in background" : "Regenerate this report"}
              </Button>
            )}
            {!readOnly && !confirmingRemove && (
              <Button type="button" variant="ghost" size="sm" className="ml-auto" disabled={remove.isPending} onClick={() => setConfirmingRemove(true)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Remove
              </Button>
            )}
            {!readOnly && confirmingRemove && (
              <span className="ml-auto flex items-center gap-2 text-sm text-gray-700">
                Remove this report from this computer?
                <Button type="button" variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  {remove.isPending ? "Removing" : "Remove"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingRemove(false)}>Cancel</Button>
              </span>
            )}
          </div>
          {!readOnly && recipients === 0 && (
            <p className="text-sm text-gray-600">
              To send this report by email,{" "}
              <button type="button" onClick={jumpToRecipients} className="font-medium text-gray-900 underline underline-offset-2">add recipients under Email and automation</button>
              {" "}below.
            </p>
          )}
          <Notice result={notice.result} onDismiss={notice.clear} />
          {detail.isLoading && <div className="h-24 animate-pulse rounded-2xl bg-gray-50" />}
          {detail.error && <p role="alert" className="text-sm text-red-700">{detail.error instanceof Error ? detail.error.message : "The report could not be read."}</p>}
          {detail.data && <ReportView report={detail.data.report} />}
          {detail.data && (
            <button type="button" onClick={onToggle} className="text-sm font-medium text-gray-700 underline underline-offset-2">Close this report</button>
          )}
        </div>
      )}
    </li>
  )
}

function SettingsPanel({ tenant, status, onSaved }: { tenant: FeatureTabProps["tenant"]; status: ReportsStatus; onSaved: () => void }) {
  const settings = status.settings
  const [addresses, setAddresses] = useState(recipientText(settings.recipients))
  useEffect(() => setAddresses(recipientText(settings.recipients)), [recipientText(settings.recipients)])
  const save = useMutation({
    mutationFn: (change: Partial<Omit<ReportSettings, "lastAutomatic">>) => reportsApi.saveSettings(tenant, change),
    onSuccess: () => toast("Report settings saved.", "success"),
    onError: (error) => toast(error instanceof Error ? error.message : "The settings could not be saved.", "error"),
    onSettled: onSaved,
  })
  const groups = settings.recipients.filter((recipient) => recipient.type === "group")
  const toggle = (key: "afterScheduledBackup" | "skipEmpty" | "includeValues" | "includeActors", label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm text-gray-800">
      <input type="checkbox" className="mt-0.5 size-4 accent-coral-600" checked={settings[key]} disabled={save.isPending} onChange={(event) => save.mutate({ [key]: event.target.checked })} />
      <span>
        {label}
        {hint && <span className="block text-xs text-gray-500">{hint}</span>}
      </span>
    </label>
  )
  const last = settings.lastAutomatic
  return (
    <Tile id="report-email-settings" aria-labelledby="report-settings-heading" className="gap-4">
      <div>
        <h3 id="report-settings-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
          <Mail className="h-4 w-4 text-gray-500" aria-hidden="true" />
          Email and automation
        </h3>
        <p className="max-w-3xl text-sm text-gray-600">{status.runtimeNote}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate({ recipients: [...parseAddresses(addresses), ...groups] })
        }}
      >
        <label className="flex min-w-[280px] flex-1 flex-col gap-1.5 text-sm text-gray-700">
          Recipients
          <input
            id="report-recipients"
            type="text"
            value={addresses}
            onChange={(event) => setAddresses(event.target.value)}
            placeholder="security@contoso.com, auditor@fabrikam.com"
            className="h-10 rounded-full border border-gray-200 bg-white px-4 text-sm text-gray-900 dark:bg-input/30"
          />
          <span className="text-xs text-gray-500">Any address, inside or outside your organization, or a distribution list. Separate addresses with commas.</span>
        </label>
        <Button type="submit" disabled={save.isPending || addresses === recipientText(settings.recipients)}>Save recipients</Button>
      </form>
      <div className="grid gap-3 md:grid-cols-2">
        {toggle("afterScheduledBackup", "Make a report after every scheduled backup and send it", "Compares each scheduled backup with the one before it.")}
        {toggle("skipEmpty", "Send nothing when nothing changed")}
        {toggle("includeValues", "Show setting values", "Off: reports list which settings changed, not their values. Secret values are never shown.")}
        {toggle("includeActors", "Name who made each change", "From the audit logs. Names are personal data; turn this off when recipients should not see them.")}
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        Attach as
        <select
          className="h-9 rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-900 dark:bg-input/30"
          value={settings.attachment}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ attachment: event.target.value as "pdf" | "markdown" })}
        >
          <option value="pdf">PDF</option>
          <option value="markdown">Markdown</option>
        </select>
      </label>
      <p className="text-xs text-gray-500">Value and name settings apply to reports generated after you change them.</p>
      {last && (
        <p className={`text-sm ${last.outcome === "failed" ? "text-red-700" : "text-gray-600"}`}>
          Last report after a scheduled backup, {formatWhen(last.at)}: {last.message}
        </p>
      )}
    </Tile>
  )
}
