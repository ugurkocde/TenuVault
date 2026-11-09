import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useSelectedTenant, useTenants, type Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { canUse, LockedPreview } from "../components/PlanGate"
import { useLicense, useTenantPlan } from "../lib/license"
import { showFeaturePlanError } from "../lib/plan-dialog"
import { formatDate } from "../features/shared/change-set"
import {
  applySyncTarget,
  approveSyncTarget,
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
import { backupOf, needsSecretAck, plural, policyKey, policyStatus, readiness, type ReviewState } from "../features/sync/model"
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
        <div className="h-24 animate-pulse rounded-3xl bg-card" />
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
  const [active, setActive] = useState<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const source = tenantOf(sourceId) ?? selected

  const policies = useQuery({ queryKey: ["sync", "policies", sourceId, folder], queryFn: () => syncPolicies(source, folder) })
  const options = useQuery({ queryKey: ["sync", "targets", sourceId], queryFn: () => syncTargets(source) })
  const eligible = (options.data?.targets ?? []).filter((option) => option.eligible).map((option) => option.tenantId).slice(0, 25)
  const status = useQuery({ queryKey: ["sync", "status", sourceId, eligible.join()], queryFn: () => syncStatus(source, eligible), enabled: eligible.length > 0, staleTime: 60_000 })
  const runs = useQuery({ queryKey: ["sync", "runs", sourceId], queryFn: () => listSyncRuns(source) })
  const run = useQuery({
    queryKey: ["sync", "run", sourceId, runId],
    queryFn: () => getSyncRun(source, runId!),
    enabled: !!runId,
    // Progress is read from the stored change sets while anything writes; nothing is timed.
    refetchInterval: (query) => (active.size || query.state.data?.targets.some((target) => target.changeSet?.status === "applying") ? 1500 : false),
  })
  const runTargets = run.data?.targets ?? []

  // Links per source policy, and linked policies per target, from /api/sync status.
  const statusByPolicy = useMemo(() => {
    const byPolicy = new Map<string, Array<{ tenantName: string; entry: SyncStatusEntry }>>()
    const linked: Record<string, number> = {}
    for (const target of status.data?.targets ?? []) {
      linked[target.targetTenantId] = target.links.length
      for (const entry of target.links) {
        const key = policyKey(entry.folder, entry.sourceId)
        byPolicy.set(key, [...(byPolicy.get(key) ?? []), { tenantName: tenantOf(target.targetTenantId)?.name ?? target.targetTenantId, entry }])
      }
    }
    return { byPolicy, linked }
  }, [status.data, tenants.length])

  const policyChip = (policy: PolicyOption) => {
    if (!eligible.length) return options.isLoading ? null : { label: "Not synced yet", tone: "neutral" as const }
    if (status.isLoading) return null
    if (status.error) return { label: "Unknown", tone: "neutral" as const, title: message(status.error, "The sync status could not be read.") }
    return policyStatus(statusByPolicy.byPolicy.get(policyKey(policy.folder, policy.id)) ?? [])
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

  /** Plans the run, then reads every planned target live. Nothing is written. */
  const review = async (acknowledgeRedacted: boolean) => {
    setPlanning(true)
    setPlanError(null)
    setReviews({})
    setStep(3)
    try {
      const items = Object.values(chosen)
      const planned = await planSync(source, { title: `Sync ${plural(items.length, "policy", "policies")} from ${source.name}`.slice(0, 200), targets, items: items.map(({ folder: type, sourceId: id }) => ({ folder: type, sourceId: id })), acknowledgeRedacted })
      setRunId(planned.run.id)
      void runs.refetch()
      const detail = await fetchRun(planned.run.id)
      await Promise.all(detail.targets.map(async (target) => {
        if (!target.promotionId || target.changeSet?.status !== "in-review") return
        const tenant = tenantOf(target.targetTenantId)
        let state: ReviewState
        try {
          if (!tenant) throw new Error("This tenant is no longer connected to this app.")
          state = { preview: await previewSyncTarget(tenant, target.promotionId), error: null }
        } catch (error) {
          state = { preview: null, error: message(error, "This tenant could not be read.") }
        }
        setReviews((current) => ({ ...current, [target.targetTenantId]: state }))
      }))
    } catch (error) {
      showFeaturePlanError(error)
      setPlanError(message(error, "The sync could not be planned."))
    } finally {
      setPlanning(false)
    }
  }

  /** Runs one target's requests; a failure is kept on that target and never stops another. */
  const work = async (target: SyncTarget, request: (tenant: Tenant, promotionId: string) => Promise<unknown>) => {
    const id = target.targetTenantId
    setActive((current) => new Set([...current, id]))
    setErrors((current) => { const next = { ...current }; delete next[id]; return next })
    try {
      const tenant = tenantOf(id)
      if (!tenant || !target.promotionId) throw new Error("This tenant is no longer connected to this app.")
      await request(tenant, target.promotionId)
    } catch (error) {
      setErrors((current) => ({ ...current, [id]: message(error, "The request failed.") }))
    } finally {
      // The stored state is read again before the target stops counting as active, so the
      // result never shows the change set as it was before the request finished.
      await queryClient.refetchQueries({ queryKey: ["sync", "run", sourceId] }).catch(() => undefined)
      setActive((current) => { const next = new Set(current); next.delete(id); return next })
      void queryClient.invalidateQueries({ queryKey: ["sync", "runs", sourceId] })
      void queryClient.invalidateQueries({ queryKey: ["sync", "status", sourceId] })
    }
  }

  const approveAndSync = () => {
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
      void work(target, async (tenant, id) => {
        await approveSyncTarget(tenant, id, preview)
        await applySyncTarget(tenant, id, preview.contentHash, backup)
      })
    }
  }

  const retry = (target: SyncTarget) => {
    const changeSet = target.changeSet
    if (!changeSet) return
    void work(target, (tenant, id) => retrySyncTarget(tenant, id, changeSet.contentHash, backupOf(changeSet) ?? backup))
  }

  const openRun = (entry: SyncRun) => {
    setRunId(entry.id)
    setNotes({})
    setErrors({})
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
  }

  const runSource = run.data ? tenantOf(run.data.run.sourceTenantId) : source
  const platforms = Object.fromEntries(Object.values(chosen).map((policy) => [policy.sourceId.toLowerCase(), policy.platforms]))
  const sources = tenants

  return (
    <div className="space-y-6">
      <Stepper step={step} />

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
          onBack={() => setStep(2)}
          onApprove={approveAndSync}
          busy={active.size > 0}
        />
      )}

      {step === 4 && (
        <section aria-label="Sync result" className={`${card} p-6`}>
          {run.isLoading && <div className="h-40 animate-pulse rounded-2xl bg-gray-100" />}
          {run.error && <p className="text-sm text-red-700">{message(run.error, "The sync could not be read.")}</p>}
          {run.data && (
            <SyncResult
              source={{ name: runSource?.name ?? run.data.run.sourceTenantId, domain: runSource?.domain ?? "" }}
              policyCount={run.data.run.items.length}
              entries={resultEntries(runTargets, tenantOf, active, errors)}
              backup={backup}
              errors={errors}
              notes={notes}
              platforms={platforms}
              onRetry={retry}
              retrying={active.size > 0}
              tenantOf={tenantOf}
              onChanged={() => void run.refetch()}
            />
          )}
          <div className="mt-6 flex flex-wrap justify-between gap-3">
            <Button type="button" variant="ghost" onClick={restart}>Start a new sync</Button>
          </div>
        </section>
      )}

      <section aria-label="Recent syncs" className={`${card} space-y-3 p-6`}>
        <h2 className="text-lg font-semibold text-gray-900">Recent syncs</h2>
        {runs.isLoading && <div className="h-12 animate-pulse rounded-2xl bg-gray-100" />}
        {runs.error && <p className="text-sm text-red-700">{message(runs.error, "Recent syncs could not be loaded.")}</p>}
        {runs.data && !runs.data.runs.length && <p className="text-sm text-gray-600">No syncs from {source.name} yet.</p>}
        {!!runs.data?.runs.length && (
          <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto">
            {runs.data.runs.map((entry) => (
              <li key={entry.id}>
                <button type="button" aria-pressed={runId === entry.id && step === 4} onClick={() => openRun(entry)} className="flex w-full flex-wrap items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900">{entry.title}</span>
                    <span className="block text-xs text-gray-500">{formatDate(entry.createdAt)}. To {entry.targets.map((target) => tenantOf(target.targetTenantId)?.name ?? target.targetTenantId).join(", ")}. {entry.summary}</span>
                  </span>
                  <Chip>{plural(entry.targets.length, "target", "targets")}</Chip>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
