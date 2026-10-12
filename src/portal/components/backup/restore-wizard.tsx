import { reviewedDependencyMappings, type RecoveryReadiness } from "../../../shared/intune/recovery"
import { typeForFolder } from "../../../shared/intune/registry"
import { passwordResetWarning } from "../../../shared/intune/restore-plan"
import { ACKNOWLEDGEMENT_REQUIRED } from "../../../shared/disclaimer"
"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  SkipForward,
  Upload,
  XCircle,
} from "lucide-react"
import { Button } from "~/components/ui/button"
import { Checkbox } from "~/components/ui/checkbox"
import { cn } from "~/lib/utils"
import { mergeOutcomes, retryBatches } from "~/lib/policies/restore-retry"
import { PlanBadge, UpgradeNote } from "@desktop/components/UpgradeNote"
import { useTenantPlan } from "@desktop/lib/license"
import { restoreCountNote } from "@desktop/lib/plan-notes"
import { formatDate, formatSize, STATUS_LABEL, statusKind, type BackupSummary, type BackupTenant } from "./types"

interface CopyTarget {
  tenantId: string
  appId: string
  name: string
  domain?: string
}

interface RestoreWizardProps {
  tenant: BackupTenant
  backups: BackupSummary[]
  /** Preselected backup, for example from "Restore" in the backup history. */
  initialBackupId: string | null
  community: boolean
  canCopyToTenants: boolean
  copyCandidates: CopyTarget[]
}

type Step = "backup" | "items" | "options" | "review" | "run"
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "backup", label: "Backup" },
  { id: "items", label: "Items" },
  { id: "options", label: "Options" },
  { id: "review", label: "Review" },
  { id: "run", label: "Restore" },
]

interface BackupItem {
  path: string
  folder: string
  label: string
  area: string
  name: string
  blocker?: string
  replaceBlocker?: string
  readiness?: RecoveryReadiness
  snapshot?: unknown
}

interface LiveState {
  live?: "missing" | "same" | "changed" | "error"
  assignmentsOnly?: boolean
  liveName?: string
  error?: string
  blocker?: string
  replaceBlocker?: string
  readiness?: RecoveryReadiness
  snapshot?: unknown
}

type Plan = "create" | "copy" | "recreate" | "overwrite" | "skip" | "cannot" | "unchecked"

interface Outcome {
  path: string
  success: boolean
  action?: "created" | "updated" | "skipped" | "unchanged"
  error?: string
  warnings?: string[]
  targetTenantId?: string
  retryable?: boolean
  partial?: boolean
  policyId?: string
  repairToken?: string
}

const PLAN_TEXT: Record<Plan, string> = {
  create: "Create a [Restored] copy",
  copy: "Copy to the chosen tenants",
  recreate: "Recreate: deleted from the tenant",
  overwrite: "Overwrite the current version",
  skip: "Skip: already matches the backup",
  cannot: "Cannot be restored",
  unchecked: "Restore: the current version could not be checked",
}
/** Short labels for the summary counts. */
const PLAN_COUNT: Record<Plan, string> = {
  create: "new copies",
  copy: "copies",
  recreate: "to recreate",
  overwrite: "to overwrite",
  skip: "already match",
  cannot: "cannot be restored",
  unchecked: "not checked",
}
const PLAN_ORDER: Plan[] = ["overwrite", "recreate", "create", "copy", "unchecked", "skip", "cannot"]
const PLAN_TONE: Record<Plan, string> = {
  create: "text-gray-700",
  copy: "text-gray-700",
  recreate: "text-amber-800",
  overwrite: "text-amber-800",
  skip: "text-gray-500",
  cannot: "text-red-700",
  unchecked: "text-amber-800",
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const items = (count: number) => `${count} item${count === 1 ? "" : "s"}`

/** What replacing in place will do to the tenant, in one sentence. */
function confirmText(plans: Array<{ plan: Plan }>, tenantName: string, assignments: boolean): string {
  const overwrite = plans.filter((entry) => entry.plan === "overwrite" || entry.plan === "unchecked").length
  const recreate = plans.filter((entry) => entry.plan === "recreate").length
  const parts = [
    overwrite && `${items(overwrite)} in ${tenantName} will be overwritten${assignments ? ", including assignments" : ""}`,
    recreate && `${items(recreate)} deleted from ${tenantName} will be recreated`,
  ].filter(Boolean)
  return `${parts.join(" and ")}.`
}

/** The admin cancelled the disclaimer: the request was refused before anything was written. */
class NotAccepted extends Error {}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal })
  const data = await response.json().catch(() => ({}))
  if (response.status === ACKNOWLEDGEMENT_REQUIRED) throw new NotAccepted(data.error ?? "No changes were made.")
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`)
  return data as T
}

/**
 * Restores items from a backup in five steps: choose the backup, the items and how to restore them,
 * review what will happen to each item in the tenant as it is now, then watch the restore run.
 */
export function RestoreWizard({ tenant, backups, initialBackupId, community, canCopyToTenants, copyCandidates }: RestoreWizardProps) {
  // A backup that stopped early still holds complete snapshots of the items it saved.
  const restorable = backups.filter((backup) => statusKind(backup.status) !== "running" && backup.totalPolicies > 0)
  const [step, setStep] = useState<Step>(initialBackupId ? "items" : "backup")
  const [backupId, setBackupId] = useState<string | null>(initialBackupId)
  const backup = backups.find((entry) => entry.id === backupId) ?? null

  const [items, setItems] = useState<BackupItem[] | null>(null)
  const [itemsError, setItemsError] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const tenantPlan = useTenantPlan(tenant.credentials.tenantId)
  const countNote = restoreCountNote(tenantPlan, selected.size)
  const [query, setQuery] = useState("")
  const [openTypes, setOpenTypes] = useState<Set<string>>(new Set())

  const [mode, setMode] = useState<"copy" | "replace">("copy")
  const [assignments, setAssignments] = useState(false)
  const [copyTargets, setCopyTargets] = useState<string[]>([])
  const copying = copyTargets.length > 0
  const [mappingJson, setMappingJson] = useState("[]")
  const [mappingsConfirmed, setMappingsConfirmed] = useState(false)

  const [review, setReview] = useState<Record<string, LiveState> | null>(null)
  const [reviewError, setReviewError] = useState("")
  const [confirmed, setConfirmed] = useState(false)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ total: number; done: number; current: string | null; results: Outcome[] } | null>(null)
  const [result, setResult] = useState<{ outcome: "success" | "partial" | "failed"; message: string; results: Outcome[] } | null>(null)
  const [runPaths, setRunPaths] = useState<string[]>([])

  // The plan's limits: Community restores one item at a time, as an unassigned copy.
  useEffect(() => {
    if (!community) return
    setMode("copy")
    setAssignments(false)
  }, [community])
  // Copies to other tenants are always unassigned copies under the original names.
  useEffect(() => {
    if (!copying) return
    setMode("copy")
    setAssignments(false)
    setMappingsConfirmed(false)
  }, [copying, copyTargets.join(",")])

  useEffect(() => {
    if (initialBackupId) {
      setBackupId(initialBackupId)
      setStep("items")
    }
  }, [initialBackupId])

  // Items of the chosen backup, with names and restore blockers read from the snapshots.
  useEffect(() => {
    if (!backupId) return
    setItems(null)
    setItemsError("")
    setSelected(new Set())
    setReview(null)
    const controller = new AbortController()
    const credentials = { ...tenant.credentials, storageAccountName: tenant.storageAccountName, subscriptionId: "local", resourceGroupName: "local", backupId }
    void (async () => {
      const contents = await post<{ content: { groups: Array<{ folder: string; label: string; area: string; limitation?: string; policies: Array<{ path: string; displayName?: string }> }> } }>(
        "/api/list-backup-contents",
        credentials,
        controller.signal,
      )
      const listed: BackupItem[] = contents.content.groups.flatMap((group) =>
        group.policies.map((policy) => ({ path: policy.path, folder: group.folder, label: group.label, area: group.area, name: policy.displayName ?? policy.path, blocker: group.limitation })),
      )
      const details: Record<string, { name: string; blocker?: string; replaceBlocker?: string; snapshot?: unknown; readiness?: RecoveryReadiness }> = {}
      for (let start = 0; start < listed.length; start += 2000) {
        const preview = await post<{ items: Array<{ path: string; name: string; blocker?: string; replaceBlocker?: string; snapshot?: unknown; readiness?: RecoveryReadiness }> }>(
          "/api/restore-preview",
          { ...credentials, paths: listed.slice(start, start + 2000).map((item) => item.path) },
          controller.signal,
        )
        for (const item of preview.items) details[item.path] = item
      }
      setItems(listed.map((item) => ({ ...item, name: details[item.path]?.name ?? item.name, blocker: details[item.path]?.blocker ?? item.blocker, replaceBlocker: details[item.path]?.replaceBlocker, snapshot: details[item.path]?.snapshot, readiness: details[item.path]?.readiness })))
    })().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return
      setItemsError(error instanceof Error ? error.message : String(error))
    })
    return () => controller.abort()
  }, [backupId, tenant])

  const selectionBlocker = (item: BackupItem) => mode === "replace" && !community && !copying ? item.replaceBlocker : item.blocker

  useEffect(() => {
    setSelected((current) => new Set([...current].filter((path) => {
      const item = items?.find((entry) => entry.path === path)
      return item && !(mode === "replace" && !community && !copying ? item.replaceBlocker : item.blocker)
    })))
  }, [items, mode, community, copying])

  const itemByPath = useMemo(() => new Map((items ?? []).map((item) => [item.path, item])), [items])
  const visible = useMemo(() => {
    const text = query.trim().toLowerCase()
    return (items ?? []).filter((item) => !text || item.name.toLowerCase().includes(text) || item.label.toLowerCase().includes(text))
  }, [items, query])
  const tree = useMemo(() => {
    const areas = new Map<string, Map<string, BackupItem[]>>()
    for (const item of visible) {
      const types = areas.get(item.area) ?? new Map<string, BackupItem[]>()
      types.set(item.folder, [...(types.get(item.folder) ?? []), item])
      areas.set(item.area, types)
    }
    return areas
  }, [visible])

  const maxSelection = community ? 1 : undefined
  const toggleItems = (paths: string[], on: boolean) =>
    setSelected((current) => {
      if (maxSelection === 1) return on ? new Set(paths.slice(0, 1)) : new Set([...current].filter((path) => !paths.includes(path)))
      const next = new Set(current)
      for (const path of paths) (on ? next.add(path) : next.delete(path))
      return next
    })

  // What restoring each selected item will do, from the options and the tenant as it is now.
  const planFor = (path: string): Plan => {
    const item = itemByPath.get(path)
    const state = review?.[path]
    const blocker = state?.blocker ?? item?.blocker
    if (copying) return blocker ? "cannot" : "copy"
    if (mode === "copy") return blocker ? "cannot" : "create"
    if (state?.replaceBlocker ?? item?.replaceBlocker) return "cannot"
    if (!state?.live || state.live === "error") return "unchecked"
    if (state.live === "missing") return blocker ? "cannot" : "recreate"
    if (state.live === "same" || (state.assignmentsOnly && !assignments)) return "skip"
    return "overwrite"
  }
  const selectedPaths = [...selected]
  const plans = review ? selectedPaths.map((path) => ({ path, plan: planFor(path) })) : []
  const actionable = plans.filter((entry) => !["skip", "cannot"].includes(entry.plan)).map((entry) => entry.path)
  const changesTenant = plans.some((entry) => entry.plan === "overwrite" || entry.plan === "recreate" || entry.plan === "unchecked")

  const loadReview = async () => {
    setReview(null)
    setReviewError("")
    setConfirmed(false)
    // Copies never touch the existing items, so the tenant is only read when replacing in place.
    if (copying || mode === "copy") {
      setReview(Object.fromEntries(selectedPaths.map((path) => [path, { blocker: itemByPath.get(path)?.blocker, snapshot: itemByPath.get(path)?.snapshot }])))
      return
    }
    try {
      const preview = await post<{ items: Array<{ path: string } & LiveState> }>("/api/restore-preview", {
        ...tenant.credentials,
        storageAccountName: tenant.storageAccountName,
        backupId,
        paths: selectedPaths,
        live: true,
      })
      setReview(Object.fromEntries(preview.items.map((item) => [item.path, item])))
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
    }
  }

  const goTo = (next: Step) => {
    setStep(next)
    if (next === "review") void loadReview()
  }

  const progressId = useRef("")
  const run = async (paths: string[], retry = false) => {
    if (!backupId || !paths.length) return
    let dependencyMappings
    try { dependencyMappings = copying ? reviewedDependencyMappings(mappingJson, mappingsConfirmed, copyTargets.length) : undefined }
    catch (error) { setReviewError(error instanceof Error ? error.message : String(error)); setStep("review"); return }
    const previous = retry ? result?.results ?? [] : []
    const batches = retry ? retryBatches(previous) : [{ paths }]
    if (!batches.length) return
    const completed: Outcome[] = []
    const attempted: typeof batches = []
    setStep("run")
    setRunning(true)
    setResult(null)
    setRunPaths(paths)
    const total = batches.reduce((count, batch) => count + batch.paths.length * (batch.targetTenantId ? 1 : Math.max(copyTargets.length, 1)), 0)
    setProgress({ total, done: 0, current: null, results: previous })
    let id = ""
    const poll = setInterval(() => {
      const polledId = id
      if (!polledId) return
      void post<{ total: number; done: number; current: string | null; results: Outcome[] }>("/api/restore-backup/progress", { progressId: polledId })
        .then((state) => progressId.current === polledId && setProgress({ ...state, total, done: completed.length + state.done, results: mergeOutcomes(previous, [...completed, ...state.results]) }))
        .catch(() => undefined)
    }, 700)
    try {
      for (const batch of batches) {
        id = crypto.randomUUID()
        progressId.current = id
        const targets = copying
          ? copyCandidates.filter((target) => batch.targetTenantId
            ? target.tenantId.toLowerCase() === batch.targetTenantId
            : copyTargets.includes(target.tenantId))
          : []
        if (copying && !targets.length) throw new Error("The original target tenant is no longer connected.")
        attempted.push(batch)
        const data = await post<{ success: boolean; message: string; details?: { restoredCount: number; unchangedCount?: number; results: Outcome[] } }>("/api/restore-backup", {
          ...tenant.credentials,
          storageAccountName: tenant.storageAccountName,
          backupId,
          restoreType: "selective",
          selectedPolicies: batch.paths.map((path) => ({ path, repairToken: previous.find((item) => item.path === path && item.targetTenantId?.toLowerCase() === batch.targetTenantId)?.repairToken })),
          dependencyMappings,
          confirmMappings: mappingsConfirmed,
          mode: copying ? "copy" : mode,
          assignments: copying ? false : assignments,
          progressId: id,
          ...(copying
            ? { targetTenants: targets.map((target) => ({ tenantId: target.tenantId, appId: target.appId })) }
            : {}),
        })
        completed.push(...(data.details?.results ?? []))
      }
      const outcomes = mergeOutcomes(previous, completed)
      const handled = outcomes.filter((outcome) => outcome.success).length
      const failed = outcomes.filter((outcome) => !outcome.success && outcome.action !== "skipped").length
      setProgress((current) => (current ? { ...current, done: current.total, current: null } : current))
      setResult({ outcome: failed === 0 && handled > 0 ? "success" : handled > 0 || outcomes.some((item) => item.partial) ? "partial" : "failed",
        message: `${handled} items completed; ${failed} failed.`, results: outcomes })
    } catch (error) {
      const missing = (batch: (typeof batches)[number], outcome: Omit<Outcome, "path" | "targetTenantId">): Outcome[] => {
        const targets = copying ? (batch.targetTenantId ? [batch.targetTenantId] : copyTargets) : [undefined]
        return targets.flatMap((targetTenantId) => batch.paths.filter((path) => !completed.some((item) => item.path === path && item.targetTenantId?.toLowerCase() === targetTenantId?.toLowerCase()))
          .map((path) => ({ ...outcome, path, targetTenantId })))
      }
      // A refused disclaimer wrote nothing, so the batch it stopped stays open for another try.
      const refused = error instanceof NotAccepted ? attempted.pop() : undefined
      const notStarted = refused ? missing(refused, { success: false, retryable: true, error: "Not started: the disclaimer was not accepted." }) : []
      // A lost response leaves the write outcome unknown. Keep completed results and
      // block blind repetition of every attempted item whose result is missing.
      const known = mergeOutcomes(previous, completed)
      const unknown = attempted.flatMap((batch) => missing(batch, { success: false, retryable: false, error: "Outcome unknown. Check Intune before attempting another restore." }))
      setResult({ outcome: known.some((item) => item.success) ? "partial" : "failed",
        message: `Restore interrupted: ${error instanceof Error ? error.message : String(error)}`, results: mergeOutcomes(known, [...notStarted, ...unknown]) })
    } finally {
      clearInterval(poll)
      progressId.current = ""
      setRunning(false)
    }
  }

  const startOver = () => {
    setResult(null)
    setProgress(null)
    setSelected(new Set())
    setReview(null)
    setStep("items")
  }

  const tenantName = (id?: string) => (id ? copyCandidates.find((target) => target.tenantId.toLowerCase() === id.toLowerCase())?.name ?? id : tenant.name)
  const stepIndex = STEPS.findIndex((entry) => entry.id === step)
  const canOpen = (target: Step) => {
    if (running || step === "run") return target === "run"
    if (target === "backup") return true
    if (target === "items") return backupId !== null
    if (target === "options" || target === "review") return selected.size > 0
    return false
  }

  const card = "rounded-3xl bg-white p-6 sm:p-8"

  return (
    <div className="space-y-6">
      <ol className="flex flex-wrap items-center gap-2" aria-label="Restore steps">
        {STEPS.map((entry, index) => (
          <li key={entry.id} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canOpen(entry.id) || entry.id === step}
              onClick={() => goTo(entry.id)}
              aria-current={entry.id === step ? "step" : undefined}
              className={cn(
                "flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors",
                entry.id === step ? "bg-primary text-primary-foreground" : index < stepIndex ? "bg-white text-gray-900 hover:bg-gray-100" : "bg-white text-gray-400",
              )}
            >
              <span className="text-xs">{index + 1}</span>
              {entry.label}
            </button>
            {index < STEPS.length - 1 && <ChevronRight className="h-4 w-4 text-gray-400" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      {step === "backup" && (
        <div className={card}>
          <h2 className="text-xl font-medium tracking-tight text-gray-900">Choose a backup</h2>
          <p className="mt-1 text-sm text-gray-500">Restore brings back items as they were when the backup ran.</p>
          {restorable.length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center">
              <Upload className="mb-3 h-6 w-6 text-gray-500" />
              <p className="font-medium text-gray-900">No backups to restore from</p>
              <p className="mt-1 text-sm text-gray-500">Run a backup first.</p>
            </div>
          ) : (
            <div className="mt-5 max-h-[28rem] space-y-1 overflow-y-auto" role="listbox" aria-label="Backups">
              {restorable.map((entry) => {
                const kind = statusKind(entry.status)
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={backupId === entry.id}
                    onClick={() => {
                      setBackupId(entry.id)
                      setStep("items")
                    }}
                    className={cn("flex w-full items-center justify-between gap-4 rounded-2xl border px-4 py-3 text-left transition-colors", backupId === entry.id ? "border-blue-200 bg-blue-50" : "border-transparent hover:bg-gray-50")}
                  >
                    <span>
                      <span className="block text-sm font-medium text-gray-900">{formatDate(entry.timestamp)}</span>
                      <span className="mt-0.5 block text-xs text-gray-500">
                        {entry.totalPolicies} items, {formatSize(entry.size)}
                        {entry.scope && entry.scope.excluded.length > 0 && `, ${entry.scope.description.toLowerCase()}`}
                      </span>
                    </span>
                    <span className={cn("text-xs", kind === "success" ? "text-gray-500" : kind === "warning" ? "text-amber-800" : "text-red-700")}>{STATUS_LABEL[kind]}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {step === "items" && backup && (
        <div className={card}>
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-medium tracking-tight text-gray-900">Choose what to restore</h2>
              <p className="mt-1 text-sm text-gray-500">From the backup of {formatDate(backup.timestamp)}.{community && ` ${countNote ?? "Community restores one item at a time."}`}</p>
            </div>
            <label className="relative block md:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name or type"
                aria-label="Search items"
                className="h-10 w-full rounded-full border border-gray-300 bg-white pl-9 pr-4 text-sm placeholder:text-gray-400"
              />
            </label>
          </div>

          {!community && (
            <label className="mt-4 block text-sm text-gray-700">
              Restore method
              <select aria-label="Restore method" className="ml-3 rounded-lg border border-gray-300 p-2" value={mode} onChange={(event) => { setCopyTargets([]); setMode(event.target.value as "copy" | "replace") }}>
                <option value="copy">Create copies</option>
                <option value="replace">Replace in place</option>
              </select>
              <span className="mt-1 block text-xs text-gray-500">Choose replacement to select tenant defaults. You will review and confirm changes before restoring.</span>
            </label>
          )}

          {statusKind(backup.status) !== "success" && (
            <p className="mt-4 flex gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              This backup did not complete fully, so some items may be missing from it.
            </p>
          )}
          {itemsError && <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{itemsError}</p>}
          {!items && !itemsError && (
            <div className="flex items-center gap-2 py-10 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the backup...
            </div>
          )}

          {items && (
            <>
              <details className="mt-4 rounded-xl border p-4 text-sm"><summary className="cursor-pointer font-medium">Recovery readiness for {items.length} objects</summary>
                <p className="my-2 text-gray-600">Readiness is conservative for cross-tenant recovery. Supply installers and Apple tokens through Intune, then map supported resulting objects below. No tenant changes occur during this review.</p>
                <ul className="max-h-64 overflow-auto">{items.map(item => <li key={item.path} className="border-t py-2"><strong>{item.name}</strong>{item.readiness ? <><p>{item.readiness.automatic ? "Automatic configuration restore available" : "Review required"}</p><p>External artifacts: {item.readiness.externalArtifacts.join(" ") || "None identified"}</p><p>Missing mappings: {item.readiness.missingMappings.join(", ") || "None identified"}</p><p>Manual actions: {item.readiness.manualActions.join(" ") || "None identified"}</p></> : <p>Readiness unavailable. Retry loading the backup.</p>}</li>)}</ul>
              </details>
              {copying && <div className="mt-4 space-y-2 rounded-xl border p-4 text-sm"><label>Reviewed target dependencies (one target tenant)<textarea className="block w-full rounded border p-2 font-mono text-xs" value={mappingJson} onChange={event => { setMappingJson(event.target.value); setMappingsConfirmed(false); setReview(null) }} /></label><p>Use an array of {`{ "folder": "Apps" or "AppCategories", "sourceId": "source GUID", "targetId": "target GUID" }`}. Upload missing installers in Intune first. Other dependency families require manual recovery.</p><label><input type="checkbox" checked={mappingsConfirmed} onChange={event => setMappingsConfirmed(event.target.checked)} /> I reviewed these IDs in the selected target tenant. Target objects will be checked before any restore writes.</label></div>}
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
                <span className="text-gray-600">
                  {selected.size} of {items.length} selected
                </span>
                {!community && (
                  <span className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => toggleItems(visible.filter((item) => !selectionBlocker(item)).map((item) => item.path), true)}>
                      Select all{query ? " shown" : ""}
                    </Button>
                    <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
                      Clear
                    </Button>
                  </span>
                )}
              </div>
              <div className="mt-3 max-h-[32rem] overflow-y-auto rounded-2xl border border-gray-200">
                {tree.size === 0 && <p className="p-6 text-sm text-gray-500">No items match "{query}".</p>}
                {[...tree].map(([area, types]) => (
                  <div key={area} className="border-b border-gray-100 last:border-b-0">
                    <p className="bg-gray-50 px-4 py-2 text-xs font-medium text-gray-500">{area}</p>
                    {[...types].map(([folder, entries]) => {
                      const choosable = entries.filter((item) => !selectionBlocker(item))
                      const chosen = choosable.filter((item) => selected.has(item.path)).length
                      const expanded = openTypes.has(folder) || query.trim() !== ""
                      return (
                        <div key={folder}>
                          <div className="flex items-center gap-3 px-4 py-2.5">
                            {!community && (
                              <Checkbox
                                aria-label={`Select all ${entries[0]!.label}`}
                                disabled={choosable.length === 0}
                                checked={chosen > 0 && chosen === choosable.length ? true : chosen > 0 ? "indeterminate" : false}
                                indeterminate={chosen > 0 && chosen < choosable.length}
                                className="data-[state=indeterminate]:border-coral-600 data-[state=indeterminate]:bg-coral-600 data-[state=indeterminate]:text-white"
                                onCheckedChange={() => toggleItems(choosable.map((item) => item.path), chosen < choosable.length)}
                              />
                            )}
                            <button
                              type="button"
                              className="flex flex-1 items-center justify-between gap-3 text-left"
                              aria-expanded={expanded}
                              onClick={() =>
                                setOpenTypes((current) => {
                                  const next = new Set(current)
                                  if (next.has(folder)) next.delete(folder)
                                  else next.add(folder)
                                  return next
                                })
                              }
                            >
                              <span className="text-sm font-medium text-gray-900">{capitalize(entries[0]!.label)}</span>
                              <span className="flex items-center gap-2 text-xs text-gray-500">
                                {chosen > 0 ? `${chosen} of ${entries.length}` : entries.length}
                                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </span>
                            </button>
                          </div>
                          {expanded && (
                            <ul className="pb-2">
                              {entries.map((item) => (
                                <li key={item.path}>
                                  <label className={cn("flex items-start gap-3 px-4 py-1.5 pl-11 text-sm", selectionBlocker(item) ? "cursor-not-allowed" : "cursor-pointer hover:bg-gray-50")}>
                                    <Checkbox
                                      className="mt-0.5"
                                      checked={selected.has(item.path)}
                                      disabled={Boolean(selectionBlocker(item))}
                                      onCheckedChange={(checked) => toggleItems([item.path], checked === true)}
                                    />
                                    <span className="min-w-0">
                                      <span className={cn("block break-words", selectionBlocker(item) ? "text-gray-500" : "text-gray-900")}>{item.name}</span>
                                      {(selectionBlocker(item) || item.blocker) && <span className="block text-xs text-gray-500">{selectionBlocker(item) || "Replace only: this object cannot be copied."}</span>}
                                    </span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mt-6 flex justify-between gap-3">
            <Button variant="outline" onClick={() => setStep("backup")}>
              <ArrowLeft className="h-4 w-4" /> Other backup
            </Button>
            <Button className="bg-coral-600 text-white hover:bg-coral-700" disabled={selected.size === 0} onClick={() => setStep("options")}>
              Next <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {step === "options" && (
        <div className={card}>
          <h2 className="text-xl font-medium tracking-tight text-gray-900">How to restore</h2>
          <p className="mt-1 text-sm text-gray-500">{selected.size} item{selected.size === 1 ? "" : "s"} selected.</p>

          <div className="mt-5 space-y-3">
            {(
              [
                ["copy", "Create copies", "Each item is created next to the current one with a [Restored] name. Nothing existing changes.", Copy],
                ["replace", "Replace in place", "Items that still exist are put back to the backed-up version. Deleted items are recreated with their original name. Items that already match are left alone.", RotateCcw],
              ] as const
            ).map(([value, title, text, Icon]) => {
              const locked = (community || copying) && value === "replace"
              return (
                <label key={value} className={cn("flex items-start gap-3 rounded-2xl border p-5 transition-colors", mode === value ? "border-blue-200 bg-blue-50" : "border-gray-200", locked ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
                  <input type="radio" name="restore-mode" className="mt-1" checked={mode === value} disabled={locked} onChange={() => setMode(value)} />
                  <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-500" />
                  <span>
                    <span className="flex items-center gap-2 font-medium text-gray-900">
                      {title}
                      {community && value === "replace" && <PlanBadge feature="replaceRestore" />}
                    </span>
                    <span className="mt-1 block text-sm text-gray-500">{text}</span>
                  </span>
                </label>
              )
            })}
            {mode === "replace" && (
              <p className="text-sm text-amber-800">Restore assignments applies to every selected item. For Windows Autopilot profiles, Apple user enrollment profiles, terms and conditions, and Intune roles, turn it off and reconcile assignments in Intune. Restore assignments for supported types in a separate selection.</p>
            )}
            <label className={cn("flex items-start gap-3 rounded-2xl border border-gray-200 p-5", community || copying ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
              <input type="checkbox" className="mt-1" checked={assignments} disabled={community || copying} onChange={(event) => setAssignments(event.target.checked)} />
              <span>
                <span className="flex items-center gap-2 font-medium text-gray-900">
                  Restore assignments{community && <PlanBadge feature="restoreAssignments" />}
                </span>
                <span className="mt-1 block text-sm text-gray-500">
                  Assign restored items to the same groups and filters as in the backup. Without this, {mode === "copy" ? "copies are created unassigned" : "current assignments stay as they are"}.
                </span>
              </span>
            </label>
          </div>

          <h3 className="mb-3 mt-6 text-sm font-medium text-gray-900">Where</h3>
          <div className={cn("rounded-2xl border p-5", copying ? "border-blue-200 bg-blue-50" : "border-gray-200", !canCopyToTenants && "opacity-60")}>
            <p className="flex items-center gap-2 font-medium text-gray-900">
              Copy to other tenants instead{!canCopyToTenants && <PlanBadge feature="bulkActions" />}
            </p>
            <p className="mt-1 text-sm text-gray-500">Leave all unchecked to restore to {tenant.name}. Copies in other tenants keep their original names, get the Default scope tag and no assignments.</p>
            {canCopyToTenants &&
              (copyCandidates.length ? (
                <div className="mt-4 max-h-56 space-y-2 overflow-auto" role="group" aria-label="Tenants to copy to">
                  {copyCandidates.map((target) => (
                    <label key={target.tenantId} className="flex cursor-pointer items-center gap-3 text-sm text-gray-800">
                      <input
                        type="checkbox"
                        checked={copyTargets.includes(target.tenantId)}
                        onChange={(event) => setCopyTargets((current) => (event.target.checked ? [...current, target.tenantId] : current.filter((value) => value !== target.tenantId)))}
                      />
                      <span>
                        {target.name}
                        {target.domain && <span className="ml-2 text-xs text-gray-500">{target.domain}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-gray-500">Connect another tenant to copy items to it.</p>
              ))}
          </div>

          {/* One note per screen explains every badged option above (see PlanGate.tsx). */}
          {community ? (
            <UpgradeNote
              feature="fullRestore"
              message={`${countNote ?? "Community restores one item at a time as an unassigned copy."} Restoring many items at once, replace in place and restoring assignments are included in TenuVault Pro and MSP; copying to other tenants is included in MSP.`}
              className="mt-6"
            />
          ) : !canCopyToTenants && (
            <UpgradeNote feature="bulkActions" message="Copying to other tenants is included in TenuVault MSP. Upgrade on the License page." className="mt-6" />
          )}

          <div className="mt-6 flex justify-between gap-3">
            <Button variant="outline" onClick={() => setStep("items")}>
              <ArrowLeft className="h-4 w-4" /> Items
            </Button>
            <Button className="bg-coral-600 text-white hover:bg-coral-700" disabled={selected.size === 0} onClick={() => goTo("review")}>
              Review <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className={card}>
          <h2 className="text-xl font-medium tracking-tight text-gray-900">Review</h2>
          <p className="mt-1 text-sm text-gray-500">
            {copying
              ? `Copies go to ${copyTargets.length} tenant${copyTargets.length === 1 ? "" : "s"}; ${tenant.name} does not change.`
              : mode === "copy"
                ? `Copies are created in ${tenant.name} next to the current items${assignments ? ", with their assignments. Assigned copies reach devices at their next check-in" : ", unassigned"}.`
                : `Checked against ${tenant.name} as it is now.`}
          </p>

          {reviewError && <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{reviewError}</p>}
          {!review && !reviewError && (
            <div className="flex items-center gap-2 py-10 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> {mode === "replace" && !copying ? `Comparing with ${tenant.name}...` : "Checking the selected items..."}
            </div>
          )}

          {review && (
            <>
              <div className="mt-5 flex flex-wrap gap-2">
                {PLAN_ORDER.map((plan) => {
                  const count = plans.filter((entry) => entry.plan === plan).length
                  return count ? (
                    <span key={plan} className={cn("rounded-full bg-gray-100 px-3 py-1 text-xs font-medium", PLAN_TONE[plan])}>
                      {count} {PLAN_COUNT[plan]}
                    </span>
                  ) : null
                })}
              </div>
              <ul className="mt-4 max-h-[26rem] divide-y divide-gray-100 overflow-y-auto rounded-2xl border border-gray-200">
                {[...plans]
                  .sort((a, b) => PLAN_ORDER.indexOf(a.plan) - PLAN_ORDER.indexOf(b.plan))
                  .map(({ path, plan }) => {
                    const item = itemByPath.get(path)
                    const state = review[path]
                    const reason = plan === "cannot" ? (copying || mode === "copy" || state?.live === "missing" ? state?.blocker ?? item?.blocker : state?.replaceBlocker ?? item?.replaceBlocker) : plan === "unchecked" ? state?.error : undefined
                    const assignmentWarning = assignments && (plan === "create" || plan === "recreate") && item ? typeForFolder(item.folder)?.assignmentWarning : undefined
                    // Overwrites keep or replace live assignments; copies and recreated items reach devices only with assignments.
                    const reachesDevices = plan === "overwrite" || plan === "unchecked" || (assignments && (plan === "create" || plan === "recreate"))
                    const passwordWarning = reachesDevices ? passwordResetWarning(state?.snapshot ?? item?.snapshot) : undefined
                    return (
                      <li key={path} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
                        <span className="min-w-0">
                          <span className="block break-words text-gray-900">{item?.name ?? path}</span>
                          <span className="block text-xs text-gray-500">
                            {item ? capitalize(item.label) : ""}
                            {state?.liveName && state.liveName !== item?.name && `, now named "${state.liveName}"`}
                          </span>
                          {state?.snapshot !== undefined && <details className="mt-2"><summary className="cursor-pointer text-xs text-blue-700">Review snapshot content (may contain secrets)</summary><pre className="max-h-64 max-w-xl overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(state.snapshot, null, 2)}</pre></details>}
                          {reason && <span className="block text-xs text-gray-500">{reason}</span>}
                          {assignmentWarning && <span className="block text-xs text-amber-800">{assignmentWarning}</span>}
                          {passwordWarning && <span className="block text-xs text-amber-800">{passwordWarning}</span>}
                        </span>
                        <span className={cn("flex-shrink-0 text-right text-xs font-medium", PLAN_TONE[plan])}>{PLAN_TEXT[plan]}</span>
                      </li>
                    )
                  })}
              </ul>

              {changesTenant && (
                <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">
                  <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                  <span>
                    I understand that {confirmText(plans, tenant.name, assignments)} Changes reach devices at their next check-in. Run a backup first if you may want the current versions back.
                  </span>
                </label>
              )}
              {actionable.length === 0 && <p className="mt-5 text-sm text-gray-600">Nothing to restore: every selected item already matches the backup or cannot be restored.</p>}
            </>
          )}

          <div className="mt-6 flex justify-between gap-3">
            <Button variant="outline" onClick={() => setStep("options")}>
              <ArrowLeft className="h-4 w-4" /> Options
            </Button>
            <Button
              className="bg-coral-600 text-white hover:bg-coral-700"
              disabled={!review || actionable.length === 0 || (changesTenant && !confirmed)}
              onClick={() => void run(actionable)}
            >
              <RefreshCw className="h-4 w-4" /> Restore {actionable.length} item{actionable.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      )}

      {step === "run" && (
        <div className={card}>
          <h2 className="text-xl font-medium tracking-tight text-gray-900">{running ? "Restoring..." : "Restore finished"}</h2>
          {progress && (
            <div className="mt-4">
              <div className="flex justify-between text-sm text-gray-600">
                <span className="truncate">{running ? (progress.current ? `Restoring ${itemByPath.get(progress.current)?.name ?? progress.current.split("/").pop()}` : "Starting...") : `${progress.done} of ${progress.total} done`}</span>
                <span>
                  {progress.done} / {progress.total}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100">
                <div className="h-full rounded-full bg-coral-500 transition-all" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
              </div>
            </div>
          )}

          {result && (
            <p
              role={result.outcome === "success" ? "status" : "alert"}
              className={cn(
                "mt-5 flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium",
                result.outcome === "success" && "bg-green-50 text-green-900",
                result.outcome === "partial" && "bg-amber-50 text-amber-900",
                result.outcome === "failed" && "bg-red-50 text-red-800",
              )}
            >
              {result.outcome === "success" ? <CheckCircle className="h-4 w-4 flex-shrink-0" /> : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
              {result.message}
            </p>
          )}

          <ul className="mt-4 max-h-[26rem] divide-y divide-gray-100 overflow-y-auto">
            {(result?.results ?? progress?.results ?? []).map((outcome, index) => {
              const Icon = outcome.success ? (outcome.action === "unchanged" ? SkipForward : CheckCircle) : outcome.action === "skipped" ? Ban : XCircle
              const text = outcome.success
                ? outcome.action === "unchanged"
                  ? "Already matched the backup"
                  : outcome.action === "updated"
                    ? "Put back to the backed-up version"
                    : outcome.targetTenantId
                      ? "Copied"
                      : mode === "copy"
                        ? "Created a [Restored] copy"
                        : "Recreated"
                : outcome.error ?? "Failed"
              return (
                <li key={`${outcome.targetTenantId ?? ""}:${outcome.path}:${index}`} className="flex items-start gap-3 py-2.5 text-sm">
                  <Icon className={cn("mt-0.5 h-4 w-4 flex-shrink-0", outcome.success ? "text-green-600" : outcome.action === "skipped" ? "text-gray-500" : "text-red-600")} />
                  <span className="min-w-0">
                    <span className="block break-words text-gray-900">
                      {outcome.targetTenantId && `${tenantName(outcome.targetTenantId)}: `}
                      {itemByPath.get(outcome.path)?.name ?? outcome.path.split("/").pop()}
                    </span>
                    <span className="block text-xs text-gray-500">{text}</span>
                    {outcome.partial && outcome.policyId && <span className="block text-xs text-amber-800">Incomplete object: {outcome.policyId}. {outcome.repairToken ? "Retry repairs the remaining steps without creating another object. Repair is available for one hour in this app session." : "Check and repair it in Intune."}</span>}
                    {outcome.retryable === false && !outcome.success && <span className="block text-xs text-amber-800">Check this item in Intune before retrying; a write may already have completed.</span>}
                    {outcome.warnings?.map((warning) => (
                      <span key={warning} className="block text-xs text-amber-800">
                        {warning}
                      </span>
                    ))}
                  </span>
                </li>
              )
            })}
          </ul>

          {!running && result && (
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              {retryBatches(result.results).length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => void run(runPaths, true)}
                >
                  <RotateCcw className="h-4 w-4" /> Retry failed items
                </Button>
              )}
              <Button className="bg-coral-600 text-white hover:bg-coral-700" onClick={startOver}>
                Restore more items
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
