import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useState, type ReactNode } from "react"
import { CheckCircle2, ChevronDown, ChevronRight, Eye, History, RotateCcw, ShieldCheck, XCircle } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { toast } from "../../lib/toast"
import { ConfirmWriteDialog } from "./ConfirmWriteDialog"
import { DiffList } from "./DiffList"
import { formatDate, RESULT_TONE, STATUS_TONE, statusLabel, type ChangeSet, type ChangeSetActions, type ChangeSetPreview, type RollbackPreview } from "./change-set"
import type { SettingNames } from "../../../shared/intune/drift"
import { omittedSettingValues } from "../../../shared/frameworks/cis-display"

const STEPS = ["Review diff", "Approve", "Apply", "Results", "Rollback preview"] as const

function stepOf(changeSet: ChangeSet, preview: ChangeSetPreview | null): number {
  if (["applied", "partial", "failed", "uncertain", "applying"].includes(changeSet.status)) return 3
  if (changeSet.status === "approved") return 2
  return preview ? 1 : 0
}

/**
 * The admin who created a change set, from its creation revision. Older revisions are dropped
 * once a record holds its revision limit, so when the first kept revision is not the creation the
 * attribution is left out rather than naming a later operator.
 */
export function changeSetCreator(changeSet: Pick<ChangeSet, "createdAt" | "history">): string | null {
  const first = changeSet.history?.[0]
  return first && first.at === changeSet.createdAt && first.actor ? first.actor : null
}

const inputClass = "h-9 w-full rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

/**
 * One change set, step by step: review the diff against the live tenant, approve (bound to
 * the content hash and the target state just read), apply behind an explicit confirmation,
 * read the per-operation results, and preview a rollback. Without `actions` it is read-only.
 * `embedded` leaves out the title and status a surrounding list row already shows; `intro`
 * explains what the change does before the operations; `settingNames` shows Settings Catalog
 * differences by display name; `sourceLabel` names the source version for people; `onApplied`
 * runs after an apply or retry wrote to the tenant.
 */
export function ChangeSetFlow({ changeSet, actions, tenantName, onChanged, rollbackHint, embedded = false, intro, settingNames, sourceLabel, onApplied }: { changeSet: ChangeSet; actions: ChangeSetActions | null; tenantName: string; onChanged: () => void; rollbackHint?: string; embedded?: boolean; intro?: ReactNode; settingNames?: SettingNames; sourceLabel?: string; onApplied?: () => void }) {
  const [preview, setPreview] = useState<ChangeSetPreview | null>(null)
  const [rollback, setRollback] = useState<RollbackPreview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reviewer, setReviewer] = useState("")
  const [note, setNote] = useState("")
  const [confirm, setConfirm] = useState<"apply" | "retry" | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const run = async (label: string, action: () => Promise<unknown>, success?: string, done?: () => void) => {
    setBusy(label)
    try {
      await action()
      done?.()
      if (success) toast(success, "success")
      onChanged()
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The request failed.", "error")
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const loadPreview = () => run("preview", async () => { setPreview(await actions!.preview()) })
  const step = stepOf(changeSet, preview)
  const canReview = !!actions && ["in-review", "stale", "approved"].includes(changeSet.status)
  const canApply = !!actions && changeSet.status === "approved"
  const canRetry = !!actions && ["partial", "failed", "uncertain", "applying"].includes(changeSet.status)
  const canRollback = !!actions && changeSet.kind === "change" && !!changeSet.preChange

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {!embedded && <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{changeSet.title}</h3>}
          <p className="text-sm text-gray-500">
            {changeSet.kind === "rollback" ? "Rollback change set. " : ""}
            {/* The admin who created it, as recorded; the workflow that created it is an internal name. */}
            {changeSet.ticket ? `Ticket ${changeSet.ticket}. ` : ""}Created {formatDate(changeSet.createdAt)}{changeSetCreator(changeSet) ? ` by ${changeSetCreator(changeSet)}` : ""}. Source version {sourceLabel ?? changeSet.sourceVersion ?? "not recorded"}.
          </p>
        </div>
        {!embedded && <Chip tone={STATUS_TONE[changeSet.status]}>{statusLabel(changeSet.status)}</Chip>}
      </div>
      {intro}

      <ol className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label} aria-current={index === step ? "step" : undefined} className={`rounded-full px-3 py-1 text-xs font-medium ${index === step ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" : index < step ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      {changeSet.lastError && <p className="rounded-2xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">{changeSet.lastError}</p>}

      <section aria-label="Operations" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Operations ({changeSet.operations.length})</p>
          {canReview && (
            <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void loadPreview()}>
              <Eye className="h-4 w-4" />
              {busy === "preview" ? "Reading the tenant" : "Review against the live tenant"}
            </Button>
          )}
        </div>
        <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-100 dark:divide-gray-800 dark:border-gray-800">
          {changeSet.operations.map((operation) => {
            const result = changeSet.results[operation.key]
            const live = preview?.operations.find((entry) => entry.key === operation.key)
            const expanded = open === operation.key
            return (
              <li key={operation.key} className="p-3">
                <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : operation.key)}>
                  {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                  <Chip tone={operation.action === "delete" ? "danger" : operation.action === "create" ? "coral" : "warning"}>{operation.action}</Chip>
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100">{operation.name}</span>
                  {operation.setsAssignments && <Chip tone="warning">sets assignments</Chip>}
                  {result && <Chip tone={RESULT_TONE[result.status]}>{result.status}</Chip>}
                </button>
                {expanded && (
                  <div className="mt-3 space-y-2 pl-6 text-sm">
                    <p className="text-gray-500">Target object: {(operation.targetId ?? result?.objectId) ? <>{operation.name} <span className="break-all text-xs text-gray-400">{operation.targetId ?? result?.objectId}</span></> : "new object"}. Source: {operation.source?.label ?? "not recorded"}.</p>
                    {result?.message && <p className="text-gray-700 dark:text-gray-300">{result.message}</p>}
                    {live?.blockers.map((line, index) => <p key={`b${index}`} className="text-red-700 dark:text-red-400">{line}</p>)}
                    {live?.warnings.map((line, index) => <p key={`w${index}`} className="text-amber-800 dark:text-amber-300">{line}</p>)}
                    <p className="text-xs text-gray-500">{live ? "Difference against the live tenant now:" : "Difference recorded when the change set was created:"}</p>
                    <DiffList entries={live?.diff ?? operation.diff} truncated={live?.diffTruncated ?? operation.diffTruncated} {...(settingNames ? { names: settingNames } : {})} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {preview && (
        <section aria-label="Review" className="space-y-3 rounded-2xl bg-gray-50 p-4 text-sm dark:bg-gray-900">
          <p className="text-gray-700 dark:text-gray-300">Read {formatDate(preview.observedAt)}. {preview.notice}</p>
          {preview.blockers.length > 0 && <ul className="list-disc pl-5 text-red-700 dark:text-red-400">{preview.blockers.map((line, index) => <li key={index}>{line}</li>)}</ul>}
          {preview.irreversible.length > 0 && (
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">Irreversible steps</p>
              <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">{preview.irreversible.map((line, index) => <li key={index}>{line}</li>)}</ul>
            </div>
          )}
          <p className="text-gray-600 dark:text-gray-400">Stored approval: {preview.approval.valid ? "valid for this content and target state." : preview.approval.reason}</p>
          {/* An approval covers the whole content, including setting values a listed difference had to leave out. */}
          {settingNames && (() => {
            const omitted = changeSet.operations.reduce((sum, operation) => sum + omittedSettingValues(preview.operations.find(entry => entry.key === operation.key)?.diff ?? operation.diff), 0)
            return omitted > 0 && <p role="alert" className="font-medium text-amber-800 dark:text-amber-300">{omitted} setting {omitted === 1 ? "value is" : "values are"} not listed in the differences above. Approving covers them too: inspect the policy content before you approve.</p>
          })()}
          {canReview && preview.blockers.length === 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-gray-500">Reviewer<input className={inputClass} value={reviewer} maxLength={200} onChange={(event) => setReviewer(event.target.value)} placeholder="Name of the reviewer" /></label>
              <label className="flex flex-col gap-1 text-xs text-gray-500">Decision note<input className={inputClass} value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="Why this change is approved or rejected" /></label>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button type="button" size="sm" disabled={!!busy} onClick={() => void run("approve", () => actions!.approve({ contentHash: preview.contentHash, targetFingerprint: preview.targetFingerprint, reviewer, note }), "Approved. The approval is bound to this content and target state.")}>
                  <ShieldCheck className="h-4 w-4" />
                  Approve this content and target state
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void run("reject", () => actions!.reject({ reviewer, note }), "Rejected.")}>
                  <XCircle className="h-4 w-4" />
                  Reject
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {changeSet.review && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {changeSet.review.decision === "approved" ? "Approved" : "Rejected"} by {changeSet.review.reviewer ?? "unknown"} on {formatDate(changeSet.review.decidedAt)}{changeSet.review.note ? `: ${changeSet.review.note}` : "."}
        </p>
      )}

      {(canApply || canRetry) && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant={canApply ? "default" : "outline"} disabled={!!busy} onClick={() => { if (!preview) void loadPreview(); setConfirm(canApply ? "apply" : "retry") }}>
            <CheckCircle2 className="h-4 w-4" />
            {canApply ? "Apply to tenant" : "Reconcile and retry"}
          </Button>
          <p className="max-w-xl text-xs text-gray-500">{canApply ? "The target is read again first; any change since approval stops the apply and needs a fresh review." : "Verified operations are never written again. Uncertain ones are reconciled from live state before any write."}</p>
        </div>
      )}

      {changeSet.preChange && (
        <section aria-label="Pre-change evidence" className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
          <p className="font-medium text-gray-900 dark:text-gray-100">Pre-change evidence</p>
          <p>Backup {changeSet.preChange.backupFolder}; live state of {changeSet.preChange.objects.length} object(s) captured {formatDate(changeSet.preChange.capturedAt)}.</p>
          {changeSet.preChange.objects.filter((object) => object.redacted).map((object) => <p key={object.key}>{object.name}: masked values were not stored; automatic rollback is not supported for it.</p>)}
        </section>
      )}

      {canRollback && (
        <section aria-label="Rollback" className="space-y-3">
          <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void run("rollback", async () => setRollback(await actions!.rollbackPreview()))}>
            <RotateCcw className="h-4 w-4" />
            Preview rollback
          </Button>
          {rollback && (
            <div className="space-y-2 rounded-2xl bg-gray-50 p-4 text-sm dark:bg-gray-900">
              <p className="text-gray-700 dark:text-gray-300">{rollback.notice}</p>
              <ul className="space-y-1">
                {rollback.operations.map((operation) => (
                  <li key={operation.key} className="text-gray-800 dark:text-gray-200">
                    <Chip tone={operation.blocked ? "danger" : "neutral"}>{operation.blocked ? "blocked" : operation.action}</Chip> {operation.name}
                    {operation.blocked && <span className="text-red-700 dark:text-red-400">: {operation.blocked}</span>}
                    {operation.warnings.map((line, index) => <span key={index} className="block text-xs text-amber-800 dark:text-amber-300">{line}</span>)}
                  </li>
                ))}
              </ul>
              {rollback.manual.length > 0 && <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">{rollback.manual.map((line, index) => <li key={index}>{line}</li>)}</ul>}
              <Button type="button" size="sm" disabled={!!busy || rollback.operations.every((operation) => operation.blocked)} onClick={() => void run("rollback-create", () => actions!.rollbackCreate(), rollbackHint ?? "Rollback change set created. Review and apply it like any other change set.")}>
                Create rollback change set for review
              </Button>
            </div>
          )}
        </section>
      )}

      {changeSet.history && changeSet.history.length > 0 && (
        <section aria-label="History">
          <button type="button" className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
            <History className="h-4 w-4" /> History ({changeSet.history.length})
          </button>
          {showHistory && (
            <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto text-xs text-gray-600 dark:text-gray-400">
              {changeSet.history.map((entry, index) => <li key={index}>{formatDate(entry.at)}: {entry.reason}{entry.actor ? ` (${entry.actor})` : ""}</li>)}
            </ul>
          )}
        </section>
      )}

      <ConfirmWriteDialog
        open={confirm !== null && !!preview}
        onOpenChange={(next) => { if (!next) setConfirm(null) }}
        title={confirm === "retry" ? "Reconcile and retry this change set" : "Apply this change set"}
        tenantName={tenantName}
        irreversible={preview?.irreversible ?? []}
        unsupported={preview?.unsupportedRecovery ?? []}
        confirmLabel={confirm === "retry" ? "Reconcile and retry" : "Back up and apply"}
        busy={busy === "apply"}
        onConfirm={() => {
          const hash = changeSet.contentHash
          void run("apply", () => (confirm === "retry" ? actions!.retry(hash) : actions!.apply(hash)), "Finished. Check the result of every operation.", onApplied).then(() => setConfirm(null))
        }}
      />
    </div>
  )
}
