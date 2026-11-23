import { useEffect, useRef, useState } from "react"
import { AlertTriangle, ArrowRight, CheckCircle2, RefreshCw, Users, XCircle } from "lucide-react"
import { cn } from "~/lib/utils"
import type { Item } from "../../../shared/intune/registry"
import { assignmentsFor, assignsAnything, describeAssignment, excludesFor, mergeAssignments, REPORTS_SET_AS_DIRECT, sameAssignments } from "../../../shared/oib/assignments"
import { policyTypeName } from "../../../shared/oib/licensing"
import { OIB_PLATFORMS, type OibAssignMode, type OibPlatform, type OibPolicyAssignments, type OibRun } from "../../../shared/oib/types"
import { PlanBadge } from "../UpgradeNote"
import { AssignmentEditor, assignmentReady, assignmentSummary, assignmentTargets, groupNames, newAssignment, specFor, type AssignmentData } from "./AssignmentEditor"
import { button, card, errorText, listJoin, minutesAgo, oibRequest, PlatformPicker, platformsLabel, primary, Toggle, useOibTenant, versionsLabel, type Selections } from "./common"
import { RunsList } from "./DeployPanel"
import { batchFolders, batchFor, deployToTenant, type BackupRequest, type DeployBatch } from "./deploy-sequence"
import { ActionBar, FlowShell, useFocusOnChange } from "./FlowShell"
import { clearJob, jobProgress, startJob, useBlockingJob, useJobFinished, useOibJob } from "./jobs"
import { LoadProgress, usePlatformLoader } from "./LoadProgress"
import { joinRows, rowKey, StatusBadge, type MatchRow } from "./match-ui"
import { BackupChoice, runSummary, useRecentBackup, type DeployOutcome } from "./ReviewDeploy"
import { ChangeVersions } from "./Versions"

/**
 * Manage assignments: assign deployed OpenIntuneBaseline policies to device and user groups, add
 * groups to what they have or replace their direct assignments. Pro and MSP, like updating
 * policies in place. Every run keeps the previous assignments, so it can be undone.
 */

type Step = "platforms" | "select" | "review"
const STEPS = [{ id: "platforms", label: "Platforms" }, { id: "select", label: "Policies" }, { id: "review", label: "Review and assign" }]
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const SCOPE_LABEL = { device: "Device", user: "User" } as const


/** Deployed OIB policies whose assignments can be managed: matched to one tenant policy of the same type. */
const assignable = (r: MatchRow) => !!r.match.tenant && r.match.tenant.folder === r.policy.folder && (r.match.status === "current" || r.match.status === "outdated" || r.match.status === "newer")

const chosenPlatforms = new Map<string, OibPlatform[]>()

interface Current { policies: OibPolicyAssignments[]; groupNames: Record<string, string>; filterNames: Record<string, string>; groupsReadable: boolean }

export function ManageAssignments({ selections }: { selections: Selections }) {
  const { tenant, can } = useOibTenant()
  const job = useOibJob<DeployOutcome[]>(tenant?.tenantId, { kind: "assign", flow: "assign" })
  const [step, setStep] = useState<Step>(job ? "review" : "platforms")
  const [platforms, setPlatformsState] = useState<OibPlatform[]>(() => (tenant && chosenPlatforms.get(tenant.tenantId)) ?? [])
  const loader = usePlatformLoader(tenant, selections, platforms)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const stale = useRef(false)
  const rows = joinRows(loader.loaded).filter(assignable)
  const allowed = can("replaceRestore")

  // After a reload, drop selections that are no longer deployed.
  useEffect(() => {
    if (loader.busy || !loader.settled) return
    const open = new Set(rows.map(rowKey))
    setSelected(s => { const next = new Set([...s].filter(k => open.has(k))); return next.size === s.size ? s : next })
  }, [loader.status])

  if (!tenant) return null
  const setPlatforms = (value: OibPlatform[]) => {
    chosenPlatforms.set(tenant.tenantId, value); setPlatformsState(value)
    setSelected(s => new Set([...s].filter(k => value.includes(k.split("\n")[0] as OibPlatform))))
  }
  const running = !!job && !job.finishedAt
  const refresh = () => { stale.current = false; loader.start() }
  const compare = () => { setStep("select"); refresh() }
  const toSelect = () => !platforms.length ? setStep("platforms") : stale.current || (!loader.busy && !loader.loaded.length && !loader.failed.length) ? compare() : setStep("select")
  const goTo = (next: string) => {
    if (step === "review" && job?.finishedAt) clearJob(job.id)
    if (next === "select") toSelect()
    else setStep(next as Step)
  }
  const chosen = rows.filter(r => selected.has(rowKey(r)))
  const batches = loader.loaded.map(({ catalog }) => batchFor(catalog, chosen.filter(r => r.platform === catalog.platform).map(r => ({ source: r.policy.source, mode: "update" as const, targetId: r.match.tenant!.id, targetName: r.match.tenant!.name })))).filter(b => b.items.length)
  const loading = loader.busy || (loader.failed.length > 0 && !loader.loaded.length)
  const toggle = (r: MatchRow) => setSelected(s => { const next = new Set(s); next.has(rowKey(r)) ? next.delete(rowKey(r)) : next.add(rowKey(r)); return next })

  const description = step === "platforms" ? "Assign deployed OpenIntuneBaseline policies to device and user groups, or replace their assignments. Policies are found as in Existing Deployment."
    : step === "select" && loader.loaded.length ? <>Deployed policies matched to OpenIntuneBaseline {versionsLabel(loader.loaded.map(l => l.catalog))}. OIB marks each as a device or user policy; device groups go to device policies, user groups to user policies.</> : undefined

  return <>
    <FlowShell title="Assignments" steps={STEPS} step={step} onStep={goTo} locked={loader.busy || running} description={description}>
      {step === "platforms" && <>
        <PlatformPicker value={platforms} onChange={setPlatforms} />
        <ChangeVersions platforms={platforms} />
        <ActionBar summary={platforms.length ? `${platformsLabel(platforms)} selected` : "Select at least one platform"}>
          <button type="button" className={primary} disabled={!platforms.length} onClick={compare}>Find deployed policies<ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
        </ActionBar>
      </>}

      {step === "select" && (loading ? <>
        <LoadProgress loader={loader} platforms={platforms} selections={selections} />
        <ActionBar status={loader.line} back={{ onClick: () => goTo("platforms") }} />
      </> : <>
        {loader.failed.length > 0 && <div className="mb-5"><LoadProgress loader={loader} platforms={loader.failed} selections={selections} /></div>}
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex-1 text-sm text-gray-600">{plural(rows.length, "deployed OIB policy", "deployed OIB policies")} found. Policies the tenant does not have, or that match more than one tenant policy, are not listed.</p>
          <button type="button" className={button} onClick={compare}><RefreshCw className="h-4 w-4" aria-hidden="true" />Compare again</button>
        </div>
        <ul className="mt-4 divide-y divide-gray-100 overflow-hidden rounded-2xl bg-gray-50">{rows.map(r => {
          const scope = batchFor(loader.loaded.find(l => l.catalog.platform === r.platform)!.catalog, [{ source: r.policy.source, mode: "update" }]).items[0]?.scope
          return <li key={rowKey(r)} className="flex items-start gap-3 p-3 text-sm">
            <input type="checkbox" aria-label={`Select ${r.match.tenant!.name}`} checked={selected.has(rowKey(r))} onChange={() => toggle(r)} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-gray-900">{r.match.tenant!.name}<span className="ml-2 text-xs text-gray-500">{OIB_PLATFORMS[r.platform].label} · {policyTypeName(r.policy.policyType)}</span></p>
              <div className="mt-1 flex flex-wrap items-center gap-2"><StatusBadge match={r.match} /><span className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-600">{scope ? `${SCOPE_LABEL[scope]} policy` : "Not marked as device or user"}</span></div>
            </div>
          </li>
        })}{!rows.length && <li className="p-6 text-center text-sm text-gray-500">No deployed OpenIntuneBaseline policies were found for these platforms. Deploy them first with New Deployment or Existing Deployment.</li>}</ul>
        <ActionBar summary={!allowed ? <span className="flex flex-wrap items-center gap-2">Changing the assignments of deployed policies is part of <PlanBadge feature="replaceRestore" /></span> : chosen.length ? `${chosen.length} selected` : "Select the policies to assign"}
          status={loader.line} back={{ onClick: () => goTo("platforms") }}>
          <button type="button" className={button} disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
          <button type="button" className={button} disabled={!rows.length || selected.size === rows.length} onClick={() => setSelected(new Set(rows.map(rowKey)))}>Select all ({rows.length})</button>
          <button type="button" className={primary} disabled={!batches.length || !allowed} onClick={() => setStep("review")}>Review assignments ({chosen.length})<ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
        </ActionBar>
      </>)}

      {step === "review" && <ReviewAssign batches={batches} onBack={toSelect} onFinished={() => platforms.length && refresh()}
        next={[{ label: "Back to the policies", onClick: toSelect, primary: true }, { label: "Done", onClick: () => { setSelected(new Set()); setStep("platforms") } }]} />}
    </FlowShell>
    {step !== "platforms" && <section className={cn(card, "mt-5")} aria-label="Assignment runs"><RunsList tenant={tenant} flow="assign" onChanged={() => { if (step === "select" || job) refresh(); else stale.current = true }} empty="No assignment changes in this tenant can be undone yet." /></section>}
  </>
}

/** What the last assignment change of a tenant was started with, so a failed backup can be retried. */
const attempts = new Map<string, { batches: DeployBatch[]; choice: BackupRequest["mode"]; assignment: AssignmentData; mode: OibAssignMode }>()

function ReviewAssign({ batches: given, onBack, onFinished, next }: { batches: DeployBatch[]; onBack: () => void; onFinished: () => void; next: Array<{ label: string; onClick: () => void; primary?: boolean }> }) {
  const { tenant } = useOibTenant()
  const job = useOibJob<DeployOutcome[]>(tenant?.tenantId, { kind: "assign", flow: "assign" })
  const blocking = useBlockingJob(tenant?.tenantId, "assign")
  const [retry, setRetry] = useState<DeployBatch[] | null>(null)
  const batches = retry ?? given
  const [phase, setPhase] = useState<"review" | "confirm">("review")
  const [assignment, setAssignment] = useState<AssignmentData>(() => newAssignment())
  const [mode, setMode] = useState<OibAssignMode>("add")
  const [choice, setChoice] = useState<BackupRequest["mode"] | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState("")
  const [current, setCurrent] = useState<{ key: string; loading: boolean; value: Current | null; error: string }>({ key: "", loading: true, value: null, error: "" })
  const folders = batchFolders(batches)
  const backup = useRecentBackup(tenant, folders)
  const view = job ? job.finishedAt ? "result" : "running" : phase
  const headingRef = useFocusOnChange<HTMLHeadingElement>(view)
  useJobFinished(job, onFinished)
  const selectionKey = batches.map(b => `${b.platform}:${b.items.map(i => i.targetId).join(",")}`).join("|")

  // The current assignments of the selection, read once per selection; a newer selection drops an older answer.
  useEffect(() => {
    if (!tenant || !batches.length || job) return
    let live = true
    setCurrent({ key: selectionKey, loading: true, value: null, error: "" })
    Promise.all(batches.map(b => oibRequest<Current>({ action: "oib-assignments-read", tenantId: tenant.tenantId, appId: tenant.appId, platform: b.platform, commit: b.commit, ...(b.tag ? { tag: b.tag } : {}), items: b.items.map(i => ({ source: i.source, targetId: i.targetId })) })))
      .then(parts => live && setCurrent({ key: selectionKey, loading: false, error: "", value: {
        policies: parts.flatMap(p => p.policies),
        groupNames: Object.assign({}, ...parts.map(p => p.groupNames)), filterNames: Object.assign({}, ...parts.map(p => p.filterNames)),
        groupsReadable: parts.every(p => p.groupsReadable),
      } }))
      .catch(e => live && setCurrent({ key: selectionKey, loading: false, value: null, error: errorText(e, "The current assignments could not be read.") }))
    return () => { live = false }
  }, [tenant?.tenantId, selectionKey, !!job])

  if (!tenant) return null
  const items = batches.flatMap(b => b.items.map(i => ({ ...i, platform: b.platform })))
  const targets = assignmentTargets(items)
  const spec = specFor(assignment, targets)
  const storage = !!tenant.storageAccountName
  const fallback: BackupRequest["mode"] = !storage ? "none" : backup.usable ? "reuse" : "new"
  const backupMode = !storage ? "none" : choice === "reuse" && !backup.usable ? fallback : choice ?? fallback
  const request: BackupRequest = backupMode === "reuse" ? { mode: backupMode, folder: backup.recent!.folder } : { mode: backupMode }
  const known = current.key === selectionKey ? current.value : null
  const names = { ...known?.groupNames, ...assignment.names }
  const filterNames = { ...known?.filterNames, ...Object.fromEntries(Object.values(spec.filters).flatMap(f => f?.name ? [[f.id, f.name]] : [])) }
  const removeAll = mode === "replace" && !assignsAnything(assignment.spec)
  const ready = assignmentReady(assignment) && (mode === "replace" || assignsAnything(assignment.spec)) && !current.loading && !!known
  const unreadable = known?.policies.filter(p => p.error) ?? []
  const title = (text: string) => <h3 ref={headingRef} tabIndex={-1} className="scroll-mt-6 text-lg font-medium text-gray-900 outline-none">{text}</h3>

  /** Each selected policy now and after the change, computed here the way the main process will. */
  const preview = items.map(item => {
    const live = known?.policies.find(p => p.targetId === item.targetId)
    // Intune reports policy set assignments of app protection as direct, so replacing them is refused (see the main process).
    const appProtection = REPORTS_SET_AS_DIRECT.has(item.folder ?? "")
    const blocked = appProtection && (mode === "replace" || (!!live?.assignments?.length && excludesFor(item.scope, spec).length > 0))
    const planned = assignmentsFor({ folder: item.folder ?? "", scope: item.scope }, item.platform, spec).assignments
    const after = live?.assignments && !blocked ? mode === "replace" ? planned : mergeAssignments(live.assignments, planned, { keepExisting: REPORTS_SET_AS_DIRECT.has(item.folder ?? "") }) : undefined
    return { item, live, after, blocked, unchanged: !!live?.assignments && !!after && sameAssignments(live.assignments, after) }
  })
  const changing = preview.filter(p => p.after && !p.unchanged).length
  const describe = (list: Item[]) => list.length ? list.map(a => describeAssignment(a, names, filterNames)).join("; ") : "Not assigned"

  function start() {
    setError("")
    // Only policies the review read and that change are sent, each with the assignments it showed.
    const reviewed = new Map(preview.filter(p => p.live?.assignments && p.after && !p.unchanged).map(p => [p.item.targetId!, p.live!.assignments!]))
    const sending = batches.map(b => ({ ...b, items: b.items.filter(i => reviewed.has(i.targetId!)) })).filter(b => b.items.length)
    try {
      void startJob<DeployOutcome[]>({ tenantId: tenant!.tenantId, tenantName: tenant!.name, kind: "assign", flow: "assign", label: `Changing assignments in ${tenant!.name}` }, async context => {
        const outcomes: DeployOutcome[] = []
        const results = await deployToTenant(sending, { backup: request, storage }, async (batch, backupRequest) => {
          context.update({ detail: batches.length > 1 ? `${tenant!.name}, ${OIB_PLATFORMS[batch.platform].label}` : undefined })
          const run = await oibRequest<OibRun>({ action: "oib-assign", tenantId: tenant!.tenantId, appId: tenant!.appId, storageAccountName: tenant!.storageAccountName,
            platform: batch.platform, commit: batch.commit, ...(batch.tag ? { tag: batch.tag } : {}), items: batch.items.map(i => ({ source: i.source, targetId: i.targetId, expected: reviewed.get(i.targetId!) })), mode,
            // Only the filters this platform's policies use, so a stale filter of another platform cannot stop it.
            assignments: specFor(assignment, assignmentTargets(batch.items.map(i => ({ ...i, platform: batch.platform })))), backup: backupRequest })
          outcomes.push({ tenantId: tenant!.tenantId, tenantName: tenant!.name, platform: batch.platform, run, backup: backupRequest })
          context.setResult([...outcomes])
          return run
        })
        return results.map(r => ({ ...r, tenantId: tenant!.tenantId, tenantName: tenant!.name }))
      })
      attempts.set(tenant!.tenantId, { batches, choice: backupMode, assignment, mode })
      setPhase("review"); setAcknowledged(false); setRetry(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  if (view === "running" || view === "result") {
    const outcomes = job!.result ?? []
    const notDone = outcomes.filter(o => !o.run)
    const backupFailed = view === "result" && !job!.error && notDone.some(o => o.backupFailed)
    const attempt = backupFailed ? attempts.get(tenant.tenantId) : undefined
    const again = attempt ? attempt.batches.filter(b => notDone.some(o => o.platform === b.platform)) : []
    const heading = view === "running" ? job!.label : backupFailed && notDone.length === outcomes.length ? "Nothing was changed: the backup failed" : `Assignment change ${job!.error ? "stopped" : outcomes.some(o => o.error || o.run?.failed.length) ? "finished with problems" : "finished"}`
    return <div>
      {title(heading)}
      {view === "running" && <p className="mt-2 text-sm text-gray-600">You can leave this page: the change keeps running, and its progress and result stay here and in the sidebar.</p>}
      <AssignResult outcomes={outcomes} />
      <ActionBar status={jobProgress(job)} error={job!.error}>
        {view === "result" && again.length > 0 && <button type="button" className={primary} onClick={() => { setRetry(again); setChoice(attempt!.choice); setAssignment(attempt!.assignment); setMode(attempt!.mode); setAcknowledged(false); setPhase("review"); clearJob(job!.id) }}>Try again</button>}
        {view === "result" && next.map(action => <button key={action.label} type="button" className={action.primary && !again.length ? primary : button} onClick={() => { action.onClick(); clearJob(job!.id) }}>{action.label}</button>)}
      </ActionBar>
    </div>
  }

  if (view === "confirm") {
    const summary = assignmentSummary(assignment, targets)
    const sentences = [
      removeAll ? `Remove every direct assignment of ${plural(changing, "policy", "policies")} in ${tenant.name}.`
        : `${mode === "add" ? "Add groups to the assignments of" : "Replace the direct assignments of"} ${plural(changing, "policy", "policies")} in ${tenant.name}: ${summary.join("; ")}.`,
      preview.length - changing ? `${plural(preview.length - changing, "policy is", "policies are")} already assigned this way or could not be read, and ${preview.length - changing === 1 ? "is" : "are"} left alone.` : "",
      "Assignments that come from a policy set are not changed.",
      backupMode === "reuse" ? `No new backup: the complete backup from ${minutesAgo(backup.recent!.ageMinutes)} (${backup.recent!.folder}) is used.`
        : backupMode === "new" ? "First back up the policy types this change affects. If the backup fails, nothing is changed."
        : "No backup is taken. Undo puts back the previous assignments, saved in the run on this device.",
    ].filter(Boolean)
    return <div>
      {title("Confirm the assignment change")}
      <ul className="mt-4 space-y-2 rounded-2xl bg-gray-50 p-5 text-sm text-gray-800">{sentences.map(s => <li key={s}>{s}</li>)}</ul>
      {mode === "replace" && <div className="mt-5"><Toggle checked={acknowledged} onChange={setAcknowledged} label={removeAll ? "I understand these policies stop applying to every group they are assigned to now" : "I understand the current direct assignments of these policies are replaced"}>
        Devices and users that lose a policy stop getting its settings at their next check-in.
      </Toggle></div>}
      <ActionBar summary={blocking ? `${blocking.label} is still running. Wait for it to finish first.` : undefined} error={error} back={{ label: "Back to the review", onClick: () => setPhase("review") }}>
        <button type="button" className={primary} disabled={!!blocking || !changing || (mode === "replace" && !acknowledged)} onClick={start}><Users className="h-4 w-4" aria-hidden="true" />{backupMode === "new" ? "Back up and assign" : removeAll ? "Remove assignments" : "Assign"}</button>
      </ActionBar>
    </div>
  }

  return <div>
    {title("Review the assignments")}
    <fieldset className="mt-4">
      <legend className="text-sm font-medium text-gray-800">What to do</legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">{([["add", "Add to the current assignments", "Keeps what the policies are assigned to and adds the groups below. A group already assigned gets the filter chosen below, or keeps its own when none is chosen."], ["replace", "Replace the current assignments", "The direct assignments of the selected policies become exactly the groups below. With no groups, every direct assignment is removed."]] as const).map(([value, label, text]) =>
        <label key={value} className={cn("flex cursor-pointer items-start gap-3 rounded-2xl border p-4 text-sm", mode === value ? "border-primary bg-blue-50/60" : "border-gray-200")}>
          <input type="radio" name="oib-assign-mode" checked={mode === value} onChange={() => setMode(value)} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
          <span><span className="font-medium text-gray-900">{label}</span><span className="mt-1 block text-xs leading-5 text-gray-600">{text}</span></span>
        </label>)}</div>
    </fieldset>
    <section className="mt-5 rounded-2xl border border-gray-200 p-4" aria-label="Groups">
      <AssignmentEditor state={{ tenant, data: assignment, update: change => setAssignment(change) }} targets={targets} />
    </section>
    <section className="mt-5" aria-labelledby="oib-assign-preview">
      <h4 id="oib-assign-preview" className="text-sm font-medium text-gray-800">Current and new assignments</h4>
      {current.loading ? <p role="status" className="mt-2 text-sm text-gray-500">Reading the current assignments…</p>
        : current.error ? <p role="alert" className="mt-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{current.error}</p>
        : <ul className="mt-2 max-h-96 divide-y divide-gray-100 overflow-auto rounded-2xl bg-gray-50 text-sm">{preview.map(({ item, live, after, unchanged, blocked }) => <li key={item.targetId} className="p-3">
          <p className="text-gray-900">{live?.name ?? item.targetName ?? item.name}<span className="ml-2 text-xs text-gray-500">{item.scope ? `${SCOPE_LABEL[item.scope]} policy` : "Not marked"}</span></p>
          {live?.error ? <p className="mt-1 text-xs text-red-800">{live.error} It is left unchanged.</p> : blocked ? <p className="mt-1 text-xs text-amber-800">{mode === "replace" ? "Replace is not available for app protection policies, because Intune reports their policy set assignments as direct ones. It is left unchanged; add groups to it instead." : "Excluded groups cannot be added to an app protection policy that is already assigned, because an exclusion could remove protection from people a policy set targets. It is left unchanged; add groups without exclusions."}</p> : <>
            <p className="mt-1 text-xs text-gray-600">Now: {describe(live?.assignments ?? [])}{live?.inherited ? ` (and ${plural(live.inherited, "assignment", "assignments")} from a policy set)` : ""}</p>
            <p className={cn("mt-0.5 text-xs", unchanged ? "text-gray-500" : "text-gray-900")}>{unchanged ? "No change" : `After: ${describe(after ?? [])}`}</p>
          </>}
        </li>)}</ul>}
      {known && !known.groupsReadable && <p className="mt-2 text-xs text-gray-500">Group names cannot be read with this app's permissions, so object IDs are shown.</p>}
      {unreadable.length > 0 && <p className="mt-2 text-xs text-amber-800">{plural(unreadable.length, "policy", "policies")} could not be read and will not be changed.</p>}
    </section>
    <div className="mt-5"><BackupChoice storage={storage} backup={backup} mode={backupMode} onChoose={setChoice} noun="run" skip="Undo puts back the previous assignments, saved in the run on this device only." /></div>
    <ActionBar summary={`${plural(items.length, "policy", "policies")}${known ? `, ${changing} would change` : ""}${removeAll ? ", every direct assignment removed" : ""}`} status={backup.loading ? "Checking the latest backup" : null} error={error}
      back={{ label: "Change selection", onClick: () => { setRetry(null); onBack() } }}>
      <button type="button" className={primary} disabled={!ready || !changing || backup.loading} onClick={() => { setAcknowledged(false); setPhase("confirm") }}>Continue</button>
    </ActionBar>
  </div>
}

/** Per platform: the policies whose assignments changed, were left alone or failed. */
function AssignResult({ outcomes }: { outcomes: DeployOutcome[] }) {
  return <div className="mt-4 space-y-3">{outcomes.map((outcome, index) => {
    const { run, error } = outcome
    const name = `${outcome.tenantName}, ${OIB_PLATFORMS[outcome.platform].label}`
    if (error || !run) return <div key={index} role="alert" className="flex items-start gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800"><XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><p><strong className="font-medium">{name}:</strong> {error ?? "No result."}</p></div>
    const list = [
      ...(run.reassigned ?? []).filter(r => r.pending).map(r => ({ text: `${r.name}: outcome unknown, check the policy in Intune${r.warnings ? `. ${r.warnings.join(" ")}` : ""}`, tone: "text-amber-900" })),
      ...(run.reassigned ?? []).filter(r => !r.pending).map(r => ({ text: `${r.name}: ${r.assignment ? `assigned (${plural(r.assignment.include, "group", "groups")}${r.assignment.exclude ? `, ${r.assignment.exclude} excluded` : ""})` : "assignments removed"}${r.warnings ? `. ${r.warnings.join(" ")}` : ""}`, tone: "" })),
      ...(run.skipped ?? []).map(s => ({ text: `${s.name}: ${s.reason}`, tone: "text-gray-600" })),
      ...run.failed.map(f => ({ text: `${f.name}: ${f.error}`, tone: "text-red-800" })),
    ]
    return <div key={index} className={cn("rounded-2xl p-4 text-sm", run.failed.length ? "bg-amber-50 text-amber-950" : "bg-green-50 text-green-950")}>
      <p className="flex items-center gap-2 font-medium">{run.failed.length ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-green-700" aria-hidden="true" />}{name}: {runSummary(run)}</p>
      <p className="mt-1 text-xs leading-5 opacity-90">{run.backupFolder ? `${run.backupMode === "reuse" ? "Backup used" : "Backed up first"}: ${run.backupFolder}.` : "No backup was taken."} Undo puts back the previous assignments.{run.assignments && groupNamesLine(run)}</p>
      {list.length > 0 && <ul className="mt-2 max-h-56 space-y-0.5 overflow-auto text-xs">{list.map((item, i) => <li key={i} className={item.tone}>{item.text}</li>)}</ul>}
    </div>
  })}</div>
}

function groupNamesLine(run: OibRun): string {
  const spec = run.assignments!
  const data = newAssignment(spec)
  const parts = [spec.deviceGroups.length && `device groups ${groupNames(data, spec.deviceGroups).join(", ")}`, spec.userGroups.length && `user groups ${groupNames(data, spec.userGroups).join(", ")}`, spec.excludeDeviceGroups.length && `excluded device groups ${groupNames(data, spec.excludeDeviceGroups).join(", ")}`, spec.excludeUserGroups.length && `excluded user groups ${groupNames(data, spec.excludeUserGroups).join(", ")}`].filter(Boolean) as string[]
  return parts.length ? ` Chosen: ${listJoin(parts)}.` : ""
}
