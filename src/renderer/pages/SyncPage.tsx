import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Loader2, Undo2, XCircle } from "lucide-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useSelectedTenant, useTenants, type Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { canUse, LockedPreview } from "../components/PlanGate"
import { useLicense, useTenantPlan } from "../lib/license"
import { showFeaturePlanError } from "../lib/plan-dialog"
import { formatDate } from "../features/shared/change-set"
import {
  applySyncTarget,
  approveSyncTarget,
  discardSyncRun,
  getSyncRun,
  listSyncRuns,
  MAX_SYNC_POLICIES,
  planSync,
  previewSyncTarget,
  retrySyncTarget,
  syncPolicies,
  syncStatus,
  syncTargets,
  type PolicyOption,
  type SyncBackup,
  type SyncRun,
  type SyncStatusEntry,
  type SyncTarget,
  type SyncTargetOption,
} from "../features/sync/api"
import { awaitingReview, discardable, excludedReason, needsSecretAck, OUTCOME_CHIP, plural, policyKey, policyStatus, readiness, relativeTime, runOutcome, type ReviewState } from "../features/sync/model"
import { card, ChooseSettings, ChooseTargets, ReviewStep, Stepper, type SelectedPolicy } from "../features/sync/SyncSteps"
import { resultEntries, SyncResult } from "../features/sync/SyncResult"

const LEAD = "Copy settings from one tenant to others, one way, when you start it. Every target is reviewed and can be rolled back."
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

/**
 * Sync: copy selected policies from one tenant to others, one way and only when the admin starts
 * it. Choose settings, choose targets, review each target against its live state, then approve
 * and apply every ready target on its own with the chosen backup. The result view follows each
 * target's stored change set. Community sees what Sync does and nothing else.
 */
export default function SyncPage() {
  const { selectedTenant } = useSelectedTenant()
  const plan = useTenantPlan(selectedTenant?.credentials?.tenantId)
  const { status } = useLicense()
  return (
    <div className="mx-auto max-w-[1600px] space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-4xl font-light tracking-tight text-gray-900">Sync</h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-600">{LEAD}</p>
      </div>
      {!selectedTenant?.credentials?.tenantId ? (
        <p className="rounded-3xl bg-card p-6 text-sm text-gray-600">Connect or select a tenant to use Sync.</p>
      ) : !status ? (
        <div className="h-24 rounded-3xl bg-card motion-safe:animate-pulse" />
      ) : !canUse(plan, "sync") ? (
        <LockedPreview
          feature="sync"
          summary={LEAD}
          points={[
            "Pick policies in one tenant and copy them to another, for example from a lab tenant to production.",
            "Every target is reviewed against its live state before anything is written, with a backup first unless you skip it.",
            "The next sync updates the policies it created, so nothing is duplicated. Sync never runs on its own.",
            "Pro syncs between the two tenants of your license. Syncing to more tenants is part of MSP.",
          ]}
        />
      ) : (
        <SyncWorkspace key={selectedTenant.id} selected={selectedTenant} />
      )}
    </div>
  )
}

function SyncWorkspace({ selected }: { selected: Tenant }) {
  const queryClient = useQueryClient()
  const tenants = useTenants().filter((tenant) => tenant.credentials?.tenantId)
  const tenantOf = (tenantId: string) => tenants.find((tenant) => tenant.credentials!.tenantId.toLowerCase() === tenantId.toLowerCase())
  const [step, setStep] = useState(1)
  const [sourceId, setSourceId] = useState(selected.credentials!.tenantId.toLowerCase())
  const [folder, setFolder] = useState<string>("ConfigurationPolicies")
  const [chosen, setChosen] = useState<Record<string, SelectedPolicy>>({})
  const [targets, setTargets] = useState<string[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({})
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [backup, setBackup] = useState<SyncBackup>("new")
  const [ack, setAck] = useState(false)
  // Requests of this screen, keyed `${runId}:${promotionId}`, so a pending apply or a late error
  // of one run never shows in another run.
  const [active, setActive] = useState<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [discarding, setDiscarding] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const planRequest = useRef(0)
  const shownRun = useRef(runId)
  shownRun.current = runId
  const source = tenantOf(sourceId) ?? selected
  const pending = (id: string | null) => !!id && [...active].some((key) => key.startsWith(`${id}:`))

  // Policies and their sync status are read again when the window regains focus and after every
  // sync, rollback or new start, so a chip never shows a state from before a change.
  const policies = useQuery({ queryKey: ["sync", "policies", sourceId, folder], queryFn: () => syncPolicies(source, folder), refetchOnWindowFocus: true })
  const options = useQuery({ queryKey: ["sync", "targets", sourceId], queryFn: () => syncTargets(source) })
  const eligible = (options.data?.targets ?? []).filter((option) => option.eligible).map((option) => option.tenantId).slice(0, 25)
  const status = useQuery({ queryKey: ["sync", "status", sourceId, eligible.join()], queryFn: () => syncStatus(source, eligible), enabled: eligible.length > 0, staleTime: 10_000, refetchOnWindowFocus: true })
  const refreshStatus = () => {
    void queryClient.invalidateQueries({ queryKey: ["sync", "status", sourceId] })
    void queryClient.invalidateQueries({ queryKey: ["sync", "policies", sourceId] })
  }
  const runs = useQuery({ queryKey: ["sync", "runs", sourceId], queryFn: () => listSyncRuns(source) })
  const run = useQuery({
    queryKey: ["sync", "run", sourceId, runId],
    queryFn: () => getSyncRun(source, runId!),
    enabled: !!runId,
    // Progress is read from the stored change sets while anything writes; nothing is timed.
    refetchInterval: (query) => (pending(runId) || query.state.data?.targets.some((target) => target.changeSet?.status === "applying") ? 1500 : false),
  })
  const runTargets = run.data?.targets ?? []
  // This screen's requests and their errors for the run shown, by target tenant.
  const requestOf = (target: SyncTarget) => (runId && target.promotionId ? `${runId}:${target.promotionId}` : "")
  const shownActive = new Set(runTargets.filter((target) => active.has(requestOf(target))).map((target) => target.targetTenantId))
  const shownErrors = Object.fromEntries(runTargets.flatMap((target) => (errors[requestOf(target)] ? [[target.targetTenantId, errors[requestOf(target)]!]] : [])))

  // Links per source policy, and linked policies per target, from /api/sync status.
  const statusByPolicy = useMemo(() => {
    const byPolicy = new Map<string, Array<{ tenantName: string; entry: SyncStatusEntry }>>()
    const linked: Record<string, number> = {}
    // A target whose status could not be read leaves every policy's state there unknown.
    const unread: Array<{ tenantName: string; error: string }> = []
    for (const target of status.data?.targets ?? []) {
      if (target.error) {
        unread.push({ tenantName: tenantOf(target.targetTenantId)?.name ?? target.targetTenantId, error: target.error })
        continue
      }
      linked[target.targetTenantId] = target.links.length
      for (const entry of target.links) {
        const key = policyKey(entry.folder, entry.sourceId)
        byPolicy.set(key, [...(byPolicy.get(key) ?? []), { tenantName: tenantOf(target.targetTenantId)?.name ?? target.targetTenantId, entry }])
      }
    }
    return { byPolicy, linked, unread }
  }, [status.data, tenants.length])

  const policyChip = (policy: PolicyOption) => {
    if (!eligible.length) return options.isLoading ? null : { label: "Not synced yet", tone: "neutral" as const }
    if (status.isLoading) return null
    if (status.error) return { label: "Unknown", tone: "neutral" as const, title: message(status.error, "The sync status could not be read.") }
    return policyStatus(statusByPolicy.byPolicy.get(policyKey(policy.folder, policy.id)) ?? [], statusByPolicy.unread, source.name)
  }

  const toggle = (policy: PolicyOption) => {
    const key = policyKey(policy.folder, policy.id)
    setChosen((current) => {
      const next = { ...current }
      if (key in next) delete next[key]
      else if (Object.keys(next).length < MAX_SYNC_POLICIES) next[key] = { folder: policy.folder, sourceId: policy.id, name: policy.name, platforms: policy.platforms }
      return next
    })
  }

  const toggleTarget = (option: SyncTargetOption) => {
    if (!option.eligible) return
    const multiple = options.data?.multiple === true
    const all = options.data?.targets ?? []
    setTargets((current) => {
      if (current.includes(option.tenantId)) return current.filter((id) => id !== option.tenantId)
      // A run to more than one target needs MSP on every tenant; otherwise the new choice replaces the old.
      const combine = multiple && option.multiple && current.every((id) => all.find((entry) => entry.tenantId === id)?.multiple)
      return combine ? [...current, option.tenantId].slice(0, 25) : [option.tenantId]
    })
  }

  const fetchRun = (id: string) => queryClient.fetchQuery({ queryKey: ["sync", "run", sourceId, id], queryFn: () => getSyncRun(source, id) })

  /**
   * Reads every target of a planned run against its live state, each on its own, and keeps the
   * result of a target only while `current` holds. A target no longer in review cannot be
   * approved, so it shows why. Nothing is written.
   */
  const checkTargets = async (detail: { targets: SyncTarget[] }, current: () => boolean) => {
    await Promise.all(detail.targets.map(async (target) => {
      if (!target.promotionId || !target.changeSet || target.promotion?.status === "blocked") return
      let state: ReviewState
      if (!awaitingReview(target)) state = { preview: null, error: excludedReason(target) }
      else {
        const tenant = tenantOf(target.targetTenantId)
        try {
          if (!tenant) throw new Error("This tenant is no longer connected to this app.")
          state = { preview: await previewSyncTarget(tenant, target.promotionId), error: null }
        } catch (error) {
          state = { preview: null, error: message(error, "This tenant could not be read.") }
        }
      }
      if (current()) setReviews((shown) => ({ ...shown, [target.targetTenantId]: state }))
    }))
  }

  /** Plans the run, then reads every planned target live. Nothing is written. */
  const review = async (acknowledgeRedacted: boolean) => {
    // Only the latest plan request may show its result; leaving the review or opening a recent
    // sync abandons it, and a late answer of an abandoned request is ignored.
    const token = ++planRequest.current
    const current = () => token === planRequest.current
    setPlanning(true)
    setPlanError(null)
    setReviews({})
    // A new review starts from its own plan; planning again for the acknowledgement keeps the targets shown.
    if (!acknowledgeRedacted) setRunId(null)
    setStep(3)
    try {
      const items = Object.values(chosen)
      const planned = await planSync(source, { title: `Sync ${plural(items.length, "policy", "policies")} from ${source.name}`.slice(0, 200), targets, items: items.map(({ folder: type, sourceId: id }) => ({ folder: type, sourceId: id })), acknowledgeRedacted })
      void runs.refetch()
      if (!current()) return
      setRunId(planned.run.id)
      const detail = await fetchRun(planned.run.id)
      if (!current()) return
      await checkTargets(detail, current)
    } catch (error) {
      if (!current()) return
      showFeaturePlanError(error)
      setPlanError(message(error, "The sync could not be planned."))
    } finally {
      if (current()) setPlanning(false)
    }
  }

  /**
   * Opens a run that was planned and never approved at Review again, with its stored plan: its
   * policies, targets and acknowledgement, and every target read against its live state again.
   */
  const continueReview = async (id: string) => {
    const token = ++planRequest.current
    const current = () => token === planRequest.current
    setPlanning(true)
    setPlanError(null)
    setReviews({})
    setNotes({})
    setErrors({})
    setDiscarding({ busy: false, error: null })
    setStep(3)
    try {
      const detail = await fetchRun(id)
      if (!current()) return
      const named = new Map(detail.targets.flatMap((target) => target.promotion?.items ?? []).map((item) => [policyKey(item.folder, item.sourceId), item.sourceName]))
      setChosen(Object.fromEntries(detail.run.items.map((item) => {
        const key = policyKey(item.folder, item.sourceId)
        return [key, { folder: item.folder, sourceId: item.sourceId, name: item.sourceName ?? named.get(key) ?? item.sourceId, platforms: chosen[key]?.platforms ?? null }]
      })))
      setTargets(detail.run.targets.map((target) => target.targetTenantId))
      setAck(detail.run.options.acknowledgeRedacted)
      setRunId(id)
      await checkTargets(detail, current)
    } catch (error) {
      if (current()) setPlanError(message(error, "The sync could not be read."))
    } finally {
      if (current()) setPlanning(false)
    }
  }

  /** Discards the run shown; the main process refuses once a target was approved. */
  const discardRun = async (id: string) => {
    setDiscarding({ busy: true, error: null })
    try {
      await discardSyncRun(source, id)
      await queryClient.invalidateQueries({ queryKey: ["sync", "runs", sourceId] })
      // Only the run still shown is left; another run opened meanwhile stays as it is.
      if (shownRun.current === id) restart()
    } catch (error) {
      if (shownRun.current === id) setDiscarding({ busy: false, error: message(error, "This sync could not be discarded.") })
    } finally {
      setDiscarding((current) => (current.busy ? { ...current, busy: false } : current))
    }
  }

  /** Abandons a plan request still running, so its answer never replaces what is shown. */
  const abandonPlan = () => {
    planRequest.current++
    setPlanning(false)
  }

  /**
   * Runs one target's requests in one run; a failure is kept on that target of that run and never
   * stops another. An error that arrives after another run is shown is dropped; the stored change
   * set keeps it.
   */
  const work = async (forRun: string, target: SyncTarget, request: (tenant: Tenant, promotionId: string) => Promise<unknown>) => {
    const key = `${forRun}:${target.promotionId}`
    setActive((current) => new Set([...current, key]))
    setErrors((current) => { const next = { ...current }; delete next[key]; return next })
    try {
      const tenant = tenantOf(target.targetTenantId)
      if (!tenant || !target.promotionId) throw new Error("This tenant is no longer connected to this app.")
      await request(tenant, target.promotionId)
    } catch (error) {
      if (shownRun.current === forRun) setErrors((current) => ({ ...current, [key]: message(error, "The request failed.") }))
    } finally {
      // The stored state is read again before the target stops counting as active, so the
      // result never shows the change set as it was before the request finished.
      await queryClient.refetchQueries({ queryKey: ["sync", "run", sourceId] }).catch(() => undefined)
      setActive((current) => { const next = new Set(current); next.delete(key); return next })
      void queryClient.invalidateQueries({ queryKey: ["sync", "runs", sourceId] })
      void queryClient.invalidateQueries({ queryKey: ["sync", "status", sourceId] })
    }
  }

  const approveAndSync = () => {
    if (!runId) return
    const forRun = runId
    const left: Record<string, string> = {}
    const ready = runTargets.filter((target) => {
      const state = readiness(target, reviews[target.targetTenantId], backup, !!tenantOf(target.targetTenantId)?.resources?.storageAccountName)
      if (state.state !== "ready" && state.reason) left[target.targetTenantId] = state.reason
      return state.state === "ready"
    })
    setNotes(left)
    setStep(4)
    // Every target is approved and applied on its own, at the same time; backups queue in the engine.
    for (const target of ready) {
      const preview = reviews[target.targetTenantId]!.preview!.changeSet
      void work(forRun, target, async (tenant, id) => {
        await approveSyncTarget(tenant, id, preview, backup)
        await applySyncTarget(tenant, id, preview.contentHash, backup)
      })
    }
  }

  const retry = (target: SyncTarget) => {
    const changeSet = target.changeSet
    if (!changeSet || !runId) return
    // The route applies the choice the target was approved with; the page's draft never decides it.
    void work(runId, target, (tenant, id) => retrySyncTarget(tenant, id, changeSet.contentHash))
  }

  const openRun = (entry: SyncRun) => {
    abandonPlan()
    setRunId(entry.id)
    setNotes({})
    setErrors({})
    setDiscarding({ busy: false, error: null })
    setStep(4)
  }

  const restart = () => {
    setStep(1)
    setChosen({})
    setTargets([])
    setRunId(null)
    setReviews({})
    setNotes({})
    setErrors({})
    setAck(false)
    setPlanError(null)
    setDiscarding({ busy: false, error: null })
    refreshStatus()
  }

  // Once the run shown stops writing, the status of its policies is read again.
  const writing = runTargets.some((target) => target.changeSet?.status === "applying") || pending(runId)
  const wasWriting = useRef(false)
  useEffect(() => {
    if (wasWriting.current && !writing) refreshStatus()
    wasWriting.current = writing
  })

  const runSource = run.data ? tenantOf(run.data.run.sourceTenantId) : source
  const runPolicies = run.data ? run.data.run.items.map((item) => item.sourceName ?? chosen[policyKey(item.folder, item.sourceId)]?.name ?? runTargets.flatMap((target) => target.promotion?.items ?? []).find((entry) => policyKey(entry.folder, entry.sourceId) === policyKey(item.folder, item.sourceId))?.sourceName ?? "Policy") : []
  const platforms = Object.fromEntries(Object.values(chosen).map((policy) => [policy.sourceId.toLowerCase(), policy.platforms]))
  const sources = tenants

  return (
    <div className="space-y-6">
      <Stepper step={step} />

      <div key={step} className="sync-step">
      {step === 1 && (
        <ChooseSettings
          sources={sources}
          sourceId={sourceId}
          onSource={(id) => { setSourceId(id.toLowerCase()); setChosen({}); setTargets([]) }}
          folder={folder}
          onFolder={setFolder}
          policies={policies.data?.source ?? []}
          loading={policies.isLoading}
          error={policies.error ? message(policies.error, "Policies could not be read.") : null}
          selected={chosen}
          onToggle={toggle}
          status={policyChip}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <ChooseTargets
          sourceName={source.name}
          options={options.data?.targets ?? []}
          loading={options.isLoading}
          error={options.error ? message(options.error, "The tenants could not be checked.") : null}
          tenantOf={tenantOf}
          linked={statusByPolicy.linked}
          selected={targets}
          onToggle={toggleTarget}
          onBack={() => setStep(1)}
          onNext={() => { setAck(false); void review(false) }}
          planning={planning}
        />
      )}

      {step === 3 && (
        <ReviewStep
          targets={runTargets}
          reviews={reviews}
          planning={planning}
          planError={planError}
          reading={{ source: source.name, targets: targets.length }}
          tenantOf={tenantOf}
          backup={backup}
          onBackup={setBackup}
          secrets={{ needed: needsSecretAck(runTargets), acknowledged: run.data?.run.options.acknowledgeRedacted === true }}
          ack={ack}
          onAck={(checked) => {
            setAck(checked)
            // Secrets block a plan until they are acknowledged, so the acknowledgement plans again.
            if (checked && run.data?.run.options.acknowledgeRedacted !== true) void review(true)
          }}
          onBack={() => { abandonPlan(); setStep(2) }}
          onApprove={approveAndSync}
          busy={pending(runId)}
        />
      )}

      {step === 4 && (
        <section aria-label="Sync result" className={`${card} p-6`}>
          {run.isLoading && <div aria-busy="true" aria-label="Reading the sync" className="sync-skeleton h-40 rounded-2xl bg-gray-100" />}
          {run.error && <p className="text-sm text-red-700">{message(run.error, "The sync could not be read.")}</p>}
          {run.data && (
            <SyncResult
              source={{ name: runSource?.name ?? run.data.run.sourceTenantId, domain: runSource?.domain ?? "" }}
              policies={runPolicies}
              policyCount={run.data.run.items.length}
              entries={resultEntries(runTargets, tenantOf, shownActive, shownErrors)}
              errors={shownErrors}
              notes={notes}
              platforms={platforms}
              onRetry={retry}
              retrying={shownActive.size > 0}
              tenantOf={tenantOf}
              onChanged={() => { void run.refetch(); void runs.refetch(); refreshStatus() }}
              onContinue={runTargets.some(awaitingReview) && runId ? () => void continueReview(runId) : undefined}
              onDiscard={runId && runTargets.length > 0 && discardable(runTargets) && !shownActive.size ? () => void discardRun(runId) : undefined}
              discard={discarding}
            />
          )}
          <div className="mt-6 flex flex-wrap justify-between gap-3">
            <Button type="button" variant="ghost" onClick={restart}>Start a new sync</Button>
          </div>
        </section>
      )}
      </div>

      <section aria-label="Recent syncs" className={`${card} space-y-3 p-6`}>
        <h2 className="text-lg font-semibold text-gray-900">Recent syncs</h2>
        {runs.isLoading && <div aria-busy="true" aria-label="Loading recent syncs" className="sync-skeleton h-12 rounded-2xl bg-gray-100" />}
        {runs.error && <p className="text-sm text-red-700">{message(runs.error, "Recent syncs could not be loaded.")}</p>}
        {runs.data && !runs.data.runs.length && <p className="text-sm text-gray-600">No syncs from {source.name} yet.</p>}
        {!!runs.data?.runs.length && (
          <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto">
            {runs.data.runs.map((entry) => {
              const chip = OUTCOME_CHIP[runOutcome(entry)]
              const names = entry.targets.map((target) => tenantOf(target.targetTenantId)?.name ?? target.targetTenantId)
              const from = tenantOf(entry.sourceTenantId)?.name ?? source.name
              return (
                <li key={entry.id}>
                  <button type="button" aria-pressed={runId === entry.id && step === 4} disabled={planning || discarding.busy} onClick={() => openRun(entry)} className="flex w-full flex-wrap items-center gap-3 rounded-2xl px-2 py-3 text-left transition-colors hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-secondary">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-900">{entry.title}</span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-gray-500">
                        <span className="truncate">{from}</span>
                        <ArrowRight className="h-3 w-3 shrink-0" aria-label="to" />
                        <span className="truncate" title={names.join(", ")}>{names.length === 1 ? names[0] : plural(names.length, "target", "targets")}</span>
                        <span aria-hidden="true">·</span>
                        <time dateTime={entry.createdAt} title={formatDate(entry.createdAt)} className="shrink-0">{relativeTime(entry.createdAt)}</time>
                      </span>
                    </span>
                    <OutcomeChip label={chip.label} tone={chip.tone} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

const OUTCOME_ICON = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, coral: Loader2, neutral: Undo2 } as const

/** A run's outcome as a pill with an icon; Not applied shows a clock instead of the warning sign. */
function OutcomeChip({ label, tone }: { label: string; tone: keyof typeof OUTCOME_ICON }) {
  const Icon = label === "Not applied" ? Clock : OUTCOME_ICON[tone]
  const tones = { success: "bg-green-50 text-green-700", warning: "bg-amber-50 text-amber-800", danger: "bg-red-50 text-red-700", coral: "bg-blue-50 text-blue-700", neutral: "bg-secondary text-gray-700" }
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone]}`}>
      <Icon className={`h-3.5 w-3.5${tone === "coral" ? " motion-safe:animate-spin" : ""}`} aria-hidden="true" />
      {label}
    </span>
  )
}
