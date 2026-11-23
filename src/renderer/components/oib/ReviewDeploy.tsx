import { useQueries } from "@tanstack/react-query"
import { groupAccessMissing } from "../GroupAccess"
import { servicesStatusOptions } from "../../features/notifications/optional-permissions"
import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, CheckCircle2, Rocket, RotateCcw, XCircle } from "lucide-react"
import { useTenants } from "~/contexts/TenantContext"
import { settingsHref } from "../../lib/settings-section"
import { cn } from "~/lib/utils"
import { assignsAnything, specGroupIds } from "../../../shared/oib/assignments"
import { OIB_BACKUP_REUSE_MINUTES, OIB_PLATFORMS, type OibBackupOptions, type OibRecentBackup, type OibRun } from "../../../shared/oib/types"
import { AssignmentEditor, assignmentReady, assignmentSummary, assignmentTargets, newAssignment, specFor, type AssignmentData } from "./AssignmentEditor"
import { PlanBadge } from "../UpgradeNote"
import { button, errorText, listJoin, minutesAgo, oibRequest, primary, Toggle, useOibTenant, versionsLabel, type OibTenant } from "./common"
import { batchFolders, deployItem, deployToTenant, type BackupRequest, type BatchOutcome, type DeployBatch } from "./deploy-sequence"
import { ActionBar, useFocusOnChange } from "./FlowShell"
import { clearJob, jobProgress, startJob, useBlockingJob, useJobFinished, useOibJob, type OibFlow, type OibJob } from "./jobs"

export interface DeployOutcome extends BatchOutcome {
  tenantId: string
  tenantName: string
}
export type DeployJob = OibJob<DeployOutcome[]>

export interface NextAction {
  label: string
  onClick: () => void
  primary?: boolean
}

export function runSummary(run: OibRun): string {
  const parts = [
    run.created.length && `${run.created.length} created`,
    run.updated.length && `${run.updated.length} updated`,
    run.reassigned?.filter(r => !r.pending).length && `${run.reassigned.filter(r => !r.pending).length} reassigned`,
    run.reassigned?.filter(r => r.pending).length && `${run.reassigned.filter(r => r.pending).length} with an unknown outcome`,
    run.skipped?.length && `${run.skipped.length} left unchanged`,
    run.failed.length && `${run.failed.length} failed`,
  ].filter(Boolean)
  return parts.length ? parts.join(", ") : "Nothing changed"
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** The tenant's newest backup and whether it can stand in for a new one (complete, at most 24 hours old). */
export function useRecentBackup(tenant: OibTenant | null, folders: string[]) {
  const [state, setState] = useState<{ loading: boolean; recent: OibRecentBackup | null }>({ loading: true, recent: null })
  const key = folders.join("|")
  useEffect(() => {
    if (!tenant?.storageAccountName || !folders.length) { setState({ loading: false, recent: null }); return }
    let live = true
    setState({ loading: true, recent: null })
    oibRequest<OibBackupOptions>({ action: "oib-backup-options", tenantId: tenant.tenantId, appId: tenant.appId, storageAccountName: tenant.storageAccountName, folders })
      .then(r => live && setState({ loading: false, recent: r.recent }), () => live && setState({ loading: false, recent: null }))
    return () => { live = false }
  }, [tenant?.tenantId, tenant?.storageAccountName, key])
  const usable = !!state.recent && state.recent.complete && state.recent.ageMinutes <= OIB_BACKUP_REUSE_MINUTES
  const reason = state.recent && !usable ? state.recent.ageMinutes > OIB_BACKUP_REUSE_MINUTES ? "it is older than 24 hours." : state.recent.reason ?? (state.recent.missing.length ? `it does not cover ${listJoin(state.recent.missing)}.` : "it did not complete without errors.") : ""
  return { ...state, usable, reason }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-1 px-4 py-3 sm:grid-cols-[11rem_1fr]"><dt className="text-gray-500">{label}</dt><dd className="min-w-0 text-gray-900">{children}</dd></div>
}

function Names({ summary, names }: { summary: string; names: string[] }) {
  return <details className="group"><summary className="cursor-pointer select-none">{summary}<span className="ml-2 text-xs text-blue-700 group-open:hidden">Show</span><span className="ml-2 hidden text-xs text-blue-700 group-open:inline">Hide</span></summary>
    <ul className="mt-2 max-h-56 list-disc space-y-0.5 overflow-auto pl-5 text-xs text-gray-700">{names.map((name, i) => <li key={i}>{name}</li>)}</ul>
  </details>
}

const undoText = (kind: "deploy" | "fix") => kind === "fix" ? "Undo puts back the previous version of the policy saved in the run." : "Undo deletes the policies this run creates and puts back the previous version, saved in the run, of the policies it updates."
// Without a backup the saved previous versions are the only copy, and they live on this device.
const skipText = (kind: "deploy" | "fix") => `${undoText(kind)} Those saved versions are kept on this device only, for the most recent runs; without a backup they are the only copy.`

/** What the latest deployment of a tenant, kind and flow was started with: lets a failed backup be retried and a returning flow know its platforms. */
interface Attempt { batches: DeployBatch[]; choice: BackupRequest["mode"]; assignment: AssignmentData; extraAssignments: Record<string, AssignmentData>; alsoDeploy: string[] }
const attempts = new Map<string, Attempt>()
const attemptKey = (tenantId: string, kind: "deploy" | "fix", flow: OibFlow) => `${tenantId}\n${kind}\n${flow}`

/** The batches the tenant's latest deployment (or fix) of the flow was started with; empty when none was started in this session. */
export const startedBatches = (tenantId: string, kind: "deploy" | "fix", flow: OibFlow): DeployBatch[] => attempts.get(attemptKey(tenantId, kind, flow))?.batches ?? []

/**
 * Review, confirm, progress and result of a deployment (or of a drift fix, kind "fix") for the
 * selected tenant. The work runs in the job store, so it survives leaving the page; while a job of
 * this kind and flow exists for the tenant, its progress or result is shown instead of the review.
 * Renders its own ActionBar; place it as the content of a FlowShell step.
 */
export function ReviewDeploy({ batches: given, flow, kind = "deploy", onBack, backLabel = "Change selection", next, onFinished, notes }: {
  batches: DeployBatch[]
  flow: OibFlow
  kind?: "deploy" | "fix"
  /** Back from the review, to the selection. */
  onBack?: () => void
  backLabel?: string
  /** Actions on the result screen; the job is cleared after one runs. */
  next: (job: DeployJob) => NextAction[]
  /** Called when the job finishes while this is mounted, for example to refresh the comparison. */
  onFinished?: (job: DeployJob) => void
  /** Extra warnings for the review and confirmation, for example about copies left alongside. */
  notes?: ReactNode
}) {
  const { tenant, can } = useOibTenant()
  const tenants = useTenants()
  const job = useOibJob<DeployOutcome[]>(tenant?.tenantId, { kind, flow })
  const blocking = useBlockingJob(tenant?.tenantId, kind)
  const [phase, setPhase] = useState<"review" | "confirm">("review")
  const [assignment, setAssignment] = useState<AssignmentData>(() => newAssignment())
  // Groups exist per tenant, so each tenant of Also deploy to gets its own choices.
  const [extraAssignments, setExtraAssignments] = useState<Record<string, AssignmentData>>({})
  const [alsoDeploy, setAlsoDeploy] = useState<string[]>([])
  const [choice, setChoice] = useState<BackupRequest["mode"] | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState("")
  // Try again after a failed backup: the batches of that attempt, since the flow may have cleared or lost its selection.
  const [retry, setRetry] = useState<DeployBatch[] | null>(null)
  const batches = retry ?? given
  const folders = batchFolders(batches)
  const backup = useRecentBackup(tenant, folders)
  const view = job ? job.finishedAt ? "result" : "running" : phase
  const headingRef = useFocusOnChange<HTMLHeadingElement>(view)
  useJobFinished(job, onFinished)

  const items = batches.flatMap(b => b.items)
  const creates = items.filter(i => i.mode === "create"), updates = items.filter(i => i.mode === "update")
  const storage = !!tenant?.storageAccountName
  const bulk = can("bulkActions")
  // Updates point at policies of this tenant, so only new policies can go to other tenants.
  const others = kind === "fix" || updates.length ? [] : tenants.filter(t => t.credentials?.tenantId && t.credentials.appId && t.credentials.tenantId !== tenant?.tenantId)
  const extras: OibTenant[] = bulk ? others.filter(t => alsoDeploy.includes(t.credentials!.tenantId)).map(t => ({ tenantId: t.credentials!.tenantId, appId: t.credentials!.appId, name: t.name, storageAccountName: t.resources?.storageAccountName })) : []
  const targets = assignmentTargets(batches.flatMap(b => b.items.filter(i => i.mode === "create").map(i => ({ platform: b.platform, folder: i.folder, scope: i.scope }))))
  const extraAssignment = (tenantId: string) => extraAssignments[tenantId] ?? newAssignment()
  const updateExtra = (tenantId: string) => (change: (data: AssignmentData) => AssignmentData) => setExtraAssignments(current => ({ ...current, [tenantId]: change(current[tenantId] ?? newAssignment()) }))
  const assigning = kind === "deploy" && creates.length > 0
  const permissionStatuses = useQueries({ queries: [tenant, ...extras].map(target => servicesStatusOptions(assigning ? target : null)) })
  if (!tenant) return null
  const accessMissing = (data: AssignmentData, index: number) => groupAccessMissing(data.readable, permissionStatuses[index]?.data?.optional?.find(entry => entry.id === "groupRead")?.granted)
  const primaryMissing = accessMissing(assignment, 0)
  const extraMissing = new Map(extras.map((target, index) => [target.tenantId, accessMissing(extraAssignment(target.tenantId), index + 1)]))
  const assignmentsReady = !assigning || ((primaryMissing || assignmentReady(assignment, targets)) &&
    extras.every(t => extraMissing.get(t.tenantId) || assignmentReady(extraAssignment(t.tenantId), targets)))
  const specOf = (target: OibTenant, index: number, batch: DeployBatch) => {
    if (!assigning || (index === 0 ? primaryMissing : extraMissing.get(target.tenantId))) return undefined
    const data = index === 0 ? assignment : extraAssignment(target.tenantId)
    const spec = specFor(data, assignmentTargets(batch.items.filter(i => i.mode === "create").map(i => ({ platform: batch.platform, folder: i.folder, scope: i.scope }))))
    return specGroupIds(spec).length || Object.values(spec.filters).some(Boolean) ? spec : undefined
  }
  const fallback: BackupRequest["mode"] = !storage ? "none" : backup.usable ? "reuse" : "new"
  const mode = !storage ? "none" : choice === "reuse" && !backup.usable ? fallback : choice ?? fallback
  const request: BackupRequest = mode === "reuse" ? { mode, folder: backup.recent!.folder } : { mode }
  const noun = kind === "fix" ? "drift fix" : "deployment"
  const backupLabel = mode === "reuse" ? `Use the backup from ${minutesAgo(backup.recent!.ageMinutes)}` : mode === "new" ? "Back up the affected policy types first" : "No backup"
  const updateNames = updates.map(u => u.targetName && u.targetName !== u.name ? `${u.targetName}, replaced with ${u.name ?? u.source}` : u.name ?? u.source)

  function deploy() {
    setError("")
    const targets = [tenant!, ...extras]
    try {
      void startJob<DeployOutcome[]>({ tenantId: tenant!.tenantId, tenantName: tenant!.name, kind, flow, label: kind === "fix" ? `Fixing drift in ${tenant!.name}` : `Deploying to ${targets.length > 1 ? `${targets.length} tenants` : tenant!.name}` }, async context => {
        const outcomes: DeployOutcome[] = []
        for (const [index, target] of targets.entries()) {
          context.poll(target.tenantId)
          const live: DeployOutcome[] = []
          // The recent backup belongs to the first tenant; other tenants back up their own affected folders.
          const results = await deployToTenant(batches, { backup: index === 0 || request.mode === "none" ? request : { mode: "new" }, storage: !!target.storageAccountName }, async (batch, backupRequest) => {
            context.update({ detail: targets.length > 1 || batches.length > 1 ? `${target.name}, ${OIB_PLATFORMS[batch.platform].label}` : undefined })
            const spec = specOf(target, index, batch)
            const run = await oibRequest<OibRun>({ action: kind === "fix" ? "oib-fix" : "oib-deploy", tenantId: target.tenantId, appId: target.appId, storageAccountName: target.storageAccountName,
              platform: batch.platform, commit: batch.commit, ...(batch.tag ? { tag: batch.tag } : {}), items: batch.items.map(deployItem), backup: backupRequest,
              ...(spec && batch.items.some(i => i.mode === "create") ? { assignments: spec } : {}), ...(index > 0 ? { bulk: true } : {}) })
            live.push({ tenantId: target.tenantId, tenantName: target.name, platform: batch.platform, run, backup: backupRequest })
            context.setResult([...outcomes, ...live])
            return run
          })
          outcomes.push(...results.map(r => ({ ...r, tenantId: target.tenantId, tenantName: target.name })))
          context.setResult([...outcomes])
        }
        return outcomes
      })
      attempts.set(attemptKey(tenant!.tenantId, kind, flow), { batches, choice: mode, assignment, extraAssignments, alsoDeploy })
      setPhase("review"); setAcknowledged(false); setRetry(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const outcomes = job?.result ?? []
  const notDeployed = outcomes.filter(o => !o.run)
  const nothingDeployed = outcomes.length > 0 && notDeployed.length === outcomes.length
  // A backup that failed (or could not be used) stops a tenant's run before any policy changes.
  const backupFailed = view === "result" && !job!.error && notDeployed.some(o => o.backupFailed)
  const heading = view === "running" ? job!.label
    : view === "result" ? backupFailed ? nothingDeployed ? `Nothing was ${kind === "fix" ? "reset" : "deployed"}: the backup failed` : "Some platforms were not deployed"
      : `${kind === "fix" ? "Drift fix" : "Deployment"} ${job!.error ? "stopped" : job!.result?.some(o => o.error || o.run?.failed.length) ? "finished with problems" : "finished"}`
    : view === "confirm" ? `Confirm the ${noun}` : `Review the ${noun}`
  const title = <h3 ref={headingRef} tabIndex={-1} className="scroll-mt-6 text-lg font-medium text-gray-900 outline-none">{heading}</h3>

  if (view === "running" || view === "result") {
    // Try again repeats what was not deployed with the same backup choice: all of it, or this tenant's skipped platforms.
    const attempt = backupFailed ? attempts.get(attemptKey(tenant.tenantId, kind, flow)) : undefined
    const skipped = notDeployed.filter(o => o.tenantId === tenant.tenantId).map(o => o.platform)
    const again = attempt ? nothingDeployed ? attempt.batches : attempt.batches.filter(b => skipped.includes(b.platform)) : []
    const retryWith = (to: "review" | "confirm") => () => {
      setRetry(again); setChoice(attempt!.choice); setAssignment(attempt!.assignment); setExtraAssignments(attempt!.extraAssignments); setAlsoDeploy(nothingDeployed ? attempt!.alsoDeploy : []); setAcknowledged(false); setPhase(to)
    }
    const actions: NextAction[] = view !== "result" ? [] : again.length
      ? [{ label: "Try again", onClick: retryWith("confirm"), primary: true }, { label: "Choose a different backup option", onClick: retryWith("review") }, ...next(job!).filter(a => !a.primary)]
      : next(job!)
    return <div>
      {title}
      {view === "running" && <p className="mt-2 text-sm text-gray-600">You can leave this page: the {noun} keeps running, and its progress and result stay here and in the sidebar.</p>}
      {backupFailed && <p className="mt-2 text-sm text-gray-700">{nothingDeployed ? "Nothing in the tenant was changed." : "The platforms below that were not deployed are unchanged."} The reason is shown below{again.length ? "; fix it or choose a different backup option, then try again" : ""}.</p>}
      <DeployResult outcomes={outcomes} kind={kind} />
      {view === "running" && !outcomes.length && kind !== "fix" && <p className="mt-4 text-sm text-gray-500">Results appear here as each platform finishes.</p>}
      <ActionBar status={jobProgress(job)} error={job!.error} summary={view === "result" ? resultSummary(outcomes) : undefined}>
        {actions.map(action => <button key={action.label} type="button" className={action.primary ? primary : button} onClick={() => { action.onClick(); clearJob(job!.id) }}>{action.label}</button>)}
      </ActionBar>
    </div>
  }

  if (view === "confirm") {
    // Where the new policies go, per tenant: groups by scope, or unassigned.
    const assignedIn = (name: string, data: AssignmentData, missing: boolean) => !missing && assignsAnything(specFor(data, targets)) ? `In ${name}: ${assignmentSummary(data, targets).join("; ")}.` : `In ${name} they stay unassigned.`
    const sentences = [
      `${kind === "fix" ? "Reset" : "Change"} ${tenant.name}${extras.length ? ` and ${plural(extras.length, "other tenant", "other tenants")} (${listJoin(extras.map(t => t.name))}), one after another` : ""}, using OpenIntuneBaseline ${versionsLabel(batches)}.`,
      creates.length ? `Create ${plural(creates.length, "policy", "policies")}${extras.length ? ` in each tenant` : ""}. ${[assignedIn(tenant.name, assignment, primaryMissing), ...extras.map(t => assignedIn(t.name, extraAssignment(t.tenantId), !!extraMissing.get(t.tenantId)))].join(" ")}` : "",
      updates.length ? `Replace ${plural(updates.length, "existing policy", "existing policies")} with the OIB version. Assignments, filters and scope tags stay as they are.` : "",
      mode === "reuse" ? `No new backup: the complete backup from ${minutesAgo(backup.recent!.ageMinutes)} (${backup.recent!.folder}) is used.`
        : mode === "new" ? `First back up the policy types this ${noun} changes${extras.length ? " in each tenant" : ""}. If the backup fails, nothing is changed.`
        : `No backup is taken. ${undoText(kind)}`,
    ].filter(Boolean)
    return <div>
      {title}
      <ul className="mt-4 space-y-2 rounded-2xl bg-gray-50 p-5 text-sm text-gray-800">{sentences.map(s => <li key={s}>{s}</li>)}</ul>
      {notes && <div className="mt-4">{notes}</div>}
      {updates.length > 0 && <div className="mt-5"><Toggle checked={acknowledged} onChange={setAcknowledged} label={`I understand ${updates.length === 1 ? "1 existing policy is" : `${updates.length} existing policies are`} replaced with the OIB version`}>
        Settings added or changed in Intune since the policy was deployed are replaced.
      </Toggle></div>}
      <ActionBar summary={blocking ? `${blocking.label} is still running. Wait for it to finish first.` : undefined} error={error} back={{ label: "Back to the review", onClick: () => setPhase("review") }}>
        <button type="button" className={primary} disabled={!!blocking || !assignmentsReady || (updates.length > 0 && !acknowledged)} onClick={deploy}>
          {kind === "fix" ? <RotateCcw className="h-4 w-4" aria-hidden="true" /> : <Rocket className="h-4 w-4" aria-hidden="true" />}
          {mode === "new" ? `Back up and ${kind === "fix" ? "reset" : "deploy"}` : kind === "fix" ? "Reset the policy" : "Deploy"}{extras.length ? ` to ${extras.length + 1} tenants` : ""}
        </button>
      </ActionBar>
    </div>
  }

  return <div>
    {title}
    <dl className="mt-4 divide-y divide-gray-100 rounded-2xl bg-gray-50 text-sm">
      <Row label="Tenant">{tenant.name}{extras.length > 0 && <span className="text-gray-600">, then {listJoin(extras.map(t => t.name))}</span>}</Row>
      <Row label="Version">{versionsLabel(batches)}</Row>
      {creates.length > 0 && <Row label="New policies"><Names summary={plural(creates.length, "policy is created", "policies are created")} names={creates.map(c => c.name ?? c.source)} /></Row>}
      {updates.length > 0 && <Row label="Updated in place"><Names summary={plural(updates.length, "policy is replaced", "policies are replaced")} names={updateNames} /></Row>}
      <Row label="Backup">{backup.loading ? "Checking the latest backup" : backupLabel}</Row>
    </dl>
    {notes && <div className="mt-4">{notes}</div>}
    <div className="mt-5 space-y-5">
      <BackupChoice storage={storage} backup={backup} mode={mode} onChoose={setChoice} noun={noun} skip={skipText(kind)} />
      {assigning && <section className="rounded-2xl border border-gray-200 p-4" aria-labelledby="oib-assignments-heading">
        <h4 id="oib-assignments-heading" className="text-sm font-medium text-gray-800">Assignments for new policies{extras.length ? ` in ${tenant.name}` : ""}</h4>
        <p className="mb-4 mt-1 text-xs leading-5 text-gray-500">OpenIntuneBaseline marks each policy as a device or user policy. Device groups go to device policies, user groups to user policies. Without groups the new policies stay unassigned, and nothing reaches devices until a policy is assigned. Start with a pilot group.</p>
        <AssignmentEditor state={{ tenant, data: assignment, update: setAssignment }} targets={targets} accessMissing={primaryMissing} accessContext="You can still deploy: the new policies are created unassigned." />
      </section>}
      {kind === "deploy" && !updates.length && <div className={cn("rounded-2xl border border-gray-200 p-4", !bulk && "opacity-60")}>
        <p className="flex items-center gap-2 text-sm font-medium text-gray-800">Also deploy to{!bulk && <PlanBadge feature="bulkActions" />}</p>
        <p className="mt-1 text-xs leading-5 text-gray-500">Create the same policies in other connected tenants after {tenant.name}, one tenant at a time. Groups exist per tenant: choose them for each tenant below, or leave its policies unassigned.{mode !== "none" && " Each tenant backs up its affected policy types first."}</p>
        {bulk && (others.length
          ? <div className="mt-3 max-h-48 space-y-2 overflow-auto" role="group" aria-label="Also deploy to">{others.map(t => <label key={t.id} className="flex items-center gap-3 text-sm text-gray-800">
            <input type="checkbox" checked={alsoDeploy.includes(t.credentials!.tenantId)} onChange={e => { const id = t.credentials!.tenantId; setAlsoDeploy(current => e.target.checked ? [...current, id] : current.filter(value => value !== id)) }} className="h-4 min-h-0 w-4 shrink-0" />
            <span>{t.name}{mode !== "none" && !t.resources?.storageAccountName && <span className="ml-2 text-xs text-amber-800">(no backup storage: skipped unless you skip the backup)</span>}</span>
          </label>)}</div>
          : <p className="mt-3 text-xs text-gray-500">Connect another tenant to deploy to it as well.</p>)}
        {extras.map(t => {
          const data = extraAssignment(t.tenantId)
          const missing = !!extraMissing.get(t.tenantId)
          return <details key={t.tenantId} className="group mt-4 rounded-2xl bg-gray-50 p-4" open={missing || !assignmentReady(data, targets) || undefined}
            onToggle={event => { if (missing && !event.currentTarget.open) event.currentTarget.open = true }}>
            <summary className="cursor-pointer select-none text-sm font-medium text-gray-800">Assignments in {t.name}<span className="ml-2 text-xs font-normal text-gray-500">{missing ? "Group access missing: created unassigned" : assignsAnything(specFor(data, targets)) ? assignmentSummary(data, targets).join("; ") : "unassigned"}</span></summary>
            <div className="mt-4"><AssignmentEditor state={{ tenant: t, data, update: updateExtra(t.tenantId) }} targets={targets} accessMissing={missing} accessContext={`Policies in ${t.name} are created unassigned.`} /></div>
          </details>
        })}
      </div>}
    </div>
    <ActionBar summary={[creates.length && plural(creates.length, "new policy", "new policies"), updates.length && plural(updates.length, "update in place", "updates in place")].filter(Boolean).join(", ")} status={backup.loading ? "Checking the latest backup" : null} error={error}
      back={onBack ? { label: backLabel, onClick: () => { setRetry(null); onBack() } } : undefined}>
      <button type="button" className={primary} disabled={!items.length || !assignmentsReady || backup.loading} onClick={() => { setAcknowledged(false); setPhase("confirm") }}>Continue</button>
    </ActionBar>
  </div>
}

/** Back up now, reuse the latest complete backup, or skip; for any OIB run that writes to the tenant. */
export function BackupChoice({ storage, backup, mode, onChoose, noun, skip }: { storage: boolean; backup: ReturnType<typeof useRecentBackup>; mode: BackupRequest["mode"]; onChoose: (mode: BackupRequest["mode"]) => void; noun: string; skip: string }) {
  const option = (value: BackupRequest["mode"], label: string, description: ReactNode) => <label className={cn("flex cursor-pointer items-start gap-3 rounded-2xl border p-4 text-sm", mode === value ? "border-primary bg-blue-50/60" : "border-gray-200")}>
    <input type="radio" name="oib-backup" value={value} checked={mode === value} onChange={() => onChoose(value)} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
    <span><span className="font-medium text-gray-900">{label}</span><span className="mt-1 block text-xs leading-5 text-gray-600">{description}</span></span>
  </label>
  return <fieldset>
    <legend className="text-sm font-medium text-gray-800">Backup before changes</legend>
    <div className="mt-2 grid gap-2" aria-busy={backup.loading}>
      {!storage ? <>
        {option("none", "Skip the backup", <>This tenant has no backup storage, so no backup can be taken. <Link to={settingsHref("signin")} className="text-blue-700 underline">Choose backup storage in Settings</Link>. {skip}</>)}
      </> : <>
        {backup.usable && option("reuse", `Use the backup from ${minutesAgo(backup.recent!.ageMinutes)}`, `Completed ${new Date(backup.recent!.completedAt).toLocaleString()} without errors and covers every policy type this ${noun} changes. Nothing is backed up again.`)}
        {option("new", "Back up the affected policy types now", `Backs up only the policy types this ${noun} changes before anything else happens. If the backup fails, nothing is changed.`)}
        {option("none", "Skip the backup", skip)}
        {backup.reason && <p className="text-xs text-gray-500">The latest backup ({minutesAgo(backup.recent!.ageMinutes)}) cannot be used: {backup.reason}</p>}
      </>}
    </div>
  </fieldset>
}

const resultSummary = (outcomes: DeployOutcome[]) => {
  const runs = outcomes.flatMap(o => o.run ? [o.run] : [])
  const count = (pick: (run: OibRun) => number) => runs.reduce((n, run) => n + pick(run), 0)
  const errors = outcomes.filter(o => o.error).length
  return [count(r => r.created.length) && `${count(r => r.created.length)} created`, count(r => r.updated.length) && `${count(r => r.updated.length)} updated`, count(r => r.failed.length) && `${count(r => r.failed.length)} failed`, errors && plural(errors, "platform not deployed", "platforms not deployed")].filter(Boolean).join(", ") || "Nothing changed"
}

/** What the new policies of a run were assigned to, in a sentence. */
function createdAssignments(run: OibRun): string {
  if (!run.created.length) return ""
  if (run.pilotGroupId && !run.assignments) return " New policies are assigned to the pilot group only."
  const assigned = run.created.filter(c => c.assignment).length
  const unknown = run.created.filter(c => c.assignmentUnknown).length
  const unassigned = run.created.length - assigned - unknown
  return [
    assigned ? ` ${plural(assigned, "new policy was", "new policies were")} assigned to the groups chosen for ${assigned === 1 ? "its" : "their"} scope.` : "",
    unknown ? ` ${plural(unknown, "new policy", "new policies")} may or may not be assigned, because ${unknown === 1 ? "its" : "their"} creation did not finish cleanly: check ${unknown === 1 ? "it" : "them"} in Intune.` : "",
    unassigned ? ` ${plural(unassigned, "new policy is", "new policies are")} unassigned: review ${unassigned === 1 ? "it" : "them"} in Intune before assigning.` : "",
  ].join("")
}

function backupUsed(outcome: DeployOutcome, kind: "deploy" | "fix"): string {
  const run = outcome.run
  const mode = run?.backupMode ?? outcome.backup?.mode
  if (mode === "reuse") return `Backup used: ${run?.backupFolder ?? (outcome.backup as { folder: string }).folder}, taken earlier.`
  if (mode === "new" && run?.backupFolder) return `Backed up first: ${run.backupFolder}.`
  return `No backup was taken. ${undoText(kind)}`
}

/** Per tenant and platform: what was created, updated, skipped or failed, and the backup used. */
export function DeployResult({ outcomes, kind = "deploy" }: { outcomes: DeployOutcome[]; kind?: "deploy" | "fix" }) {
  return <div className="mt-4 space-y-3">{outcomes.map((outcome, index) => {
    const { run, error } = outcome
    const name = `${outcome.tenantName}, ${OIB_PLATFORMS[outcome.platform].label}`
    if (error || !run) return <div key={index} role="alert" className="flex items-start gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800"><XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><p><strong className="font-medium">{name}:</strong> {error ?? "No result."}</p></div>
    const list = [
      ...run.created.map(c => ({ text: `${c.name}: ${c.partial ? "created incomplete, kept so undo can remove it" : "created"}${c.assignmentUnknown ? ". Its assignments may or may not be in place: check it in Intune" : ""}${c.warnings ? `. ${c.warnings.join(" ")}` : ""}`, tone: c.assignmentUnknown ? "text-amber-900" : "" })),
      ...run.updated.map(u => ({ text: `${u.previousName}: ${u.partial ? "partly updated" : "updated in place"} to ${u.name}${u.warnings ? `. ${u.warnings.join(" ")}` : ""}`, tone: "" })),
      ...(run.skipped ?? []).map(s => ({ text: `${s.name}: ${s.reason}`, tone: "text-gray-600" })),
      ...run.failed.map(f => ({ text: `${f.name}: ${f.error}`, tone: "text-red-800" })),
    ]
    return <div key={index} className={cn("rounded-2xl p-4 text-sm", run.failed.length ? "bg-amber-50 text-amber-950" : "bg-green-50 text-green-950")}>
      <p className="flex items-center gap-2 font-medium">{run.failed.length ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-green-700" aria-hidden="true" />}{name}: {runSummary(run)}</p>
      <p className="mt-1 text-xs leading-5 opacity-90">{run.reference}. {backupUsed(outcome, kind)}{kind === "deploy" ? createdAssignments(run) : ""}</p>
      {list.length > 0 && <ul className="mt-2 max-h-56 space-y-0.5 overflow-auto text-xs">{list.map((item, i) => <li key={i} className={item.tone}>{item.text}</li>)}</ul>}
    </div>
  })}</div>
}
