import { useCallback, useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { Undo2 } from "lucide-react"
import { cn } from "~/lib/utils"
import type { OibRun, UndoResult } from "../../../shared/oib/types"
import type { DeployBatch } from "./deploy-sequence"
import { button, card, errorText, oibRequest, primary, useOibTenant, type OibTenant } from "./common"
import { progressText } from "./FlowShell"
import { clearJob, jobProgress, startJob, useJobFinished, useOibJob, useOibJobs, useRunningJob, type OibFlow } from "./jobs"
import { ReviewDeploy, runSummary } from "./ReviewDeploy"

export type { DeployBatch }
export { runSummary }

/** The deploy review, confirmation, progress and result in a card, for flows not yet on FlowShell. */
export function DeployPanel({ batches, onDeployed }: { batches: DeployBatch[]; onDeployed?: () => void }) {
  const { tenant } = useOibTenant()
  const { flow } = useParams()
  if (!tenant) return null
  return <>
    <section className={cn(card, "mt-5")} aria-label="Deploy">
      <ReviewDeploy batches={batches} flow={(flow ?? "new") as OibFlow} onFinished={() => onDeployed?.()} next={() => [{ label: "Done", onClick: () => undefined, primary: true }]} />
    </section>
    <section className={cn(card, "mt-5")} aria-label="Deployment runs"><RunsList tenant={tenant} flow={flow as OibFlow | undefined} onChanged={onDeployed} empty="No runs that can be undone yet." /></section>
  </>
}

/**
 * Earlier runs in this tenant that can still be undone. Undo asks for confirmation in place, runs
 * in the job store (so it survives leaving the page) and is disabled while any job runs for the tenant.
 * The list refreshes when a job of the tenant finishes; `onChanged` runs after an undo.
 */
export function RunsList({ tenant, empty, flow, onChanged }: { tenant: OibTenant; empty?: string; flow?: OibFlow; onChanged?: () => void }) {
  const [runs, setRuns] = useState<OibRun[]>([])
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [loadError, setLoadError] = useState("")
  const [loading, setLoading] = useState(true)
  const running = useRunningJob(tenant.tenantId)
  const undo = useOibJob<UndoResult>(tenant.tenantId, { kind: "undo" })
  // Any finished job of the tenant (deploy, fix or undo) can change the list.
  const finished = useOibJobs().filter(j => j.tenantId === tenant.tenantId && j.finishedAt).map(j => j.finishedAt).sort().pop()
  const shownTenant = useRef(tenant.tenantId)
  const loadedTenant = useRef(tenant.tenantId)
  shownTenant.current = tenant.tenantId
  const refresh = useCallback(async () => {
    const id = tenant.tenantId
    setLoading(true)
    try {
      const response = await oibRequest<{ runs: OibRun[] }>({ action: "oib-runs", tenantId: id })
      if (shownTenant.current === id) {
        setRuns(response.runs)
        setLoadError("")
      }
    } catch (error) {
      if (shownTenant.current === id) setLoadError(errorText(error))
    } finally {
      if (shownTenant.current === id) setLoading(false)
    }
  }, [tenant.tenantId])
  useEffect(() => {
    if (loadedTenant.current !== tenant.tenantId) {
      loadedTenant.current = tenant.tenantId
      setRuns([])
      setLoadError("")
    }
    void refresh()
  }, [tenant.tenantId, finished, refresh])
  useJobFinished(undo, () => onChanged?.())

  function start(run: OibRun) {
    setError(""); setConfirming(null)
    try {
      void startJob<UndoResult>({ tenantId: tenant.tenantId, tenantName: tenant.name, kind: "undo", flow, label: `Undoing a run in ${tenant.name}` },
        () => oibRequest<UndoResult>({ action: "oib-undo", tenantId: tenant.tenantId, appId: tenant.appId, storageAccountName: tenant.storageAccountName, runId: run.runId }))
    } catch (e) {
      setError(errorText(e))
    }
  }

  const result = undo?.finishedAt ? undo : undefined
  // Its own card or below a card heading: no divider, no top margin when it comes first.
  if (!runs.length && !undo && !loadError && !loading && !error) return empty ? <p className="mt-4 text-sm text-gray-500 first:mt-0">{empty}</p> : null
  return <div className="mt-4 first:mt-0">
    <h3 className="text-sm font-medium text-gray-800">Runs that can be undone</h3>
    {loading && <p role="status" className="mt-2 text-sm text-gray-500">Loading runs...</p>}
    {loadError && <div role="alert" className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">
      <p>{loadError}</p>
      <button type="button" className={cn(button, "mt-2")} disabled={loading} onClick={() => void refresh()}>Retry</button>
    </div>}
    <ul className="mt-2 divide-y divide-gray-100">{runs.map(run => {
      const parts = [run.created.length && `deletes the ${run.created.length === 1 ? "policy" : `${run.created.length} policies`} it created`, run.updated.length && `puts back the previous version of the ${run.updated.length === 1 ? "policy" : `${run.updated.length} policies`} it updated`].filter(Boolean).join(" and ")
      return <li key={run.runId} className="py-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>{run.kind === "fix" ? "Drift reset · " : ""}{run.reference}<span className="ml-2 text-xs text-gray-500">{new Date(run.createdAt).toLocaleString()} · {runSummary(run)}</span></span>
          <button type="button" className={button} disabled={!!running || confirming === run.runId} title={running ? `${running.label} is still running` : undefined} aria-expanded={confirming === run.runId} onClick={() => setConfirming(run.runId)}><Undo2 className="h-4 w-4" aria-hidden="true" />Undo</button>
        </div>
        {confirming === run.runId && <div role="group" aria-label="Confirm undo" className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl bg-amber-50 p-4 text-amber-950">
          <p className="min-w-0 flex-1">Undo this run in <strong className="font-medium">{tenant.name}</strong>: it {parts || "changes nothing"}. Nothing else is changed.</p>
          <button type="button" className={button} onClick={() => setConfirming(null)}>Cancel</button>
          <button type="button" className={primary} disabled={!!running} onClick={() => start(run)}><Undo2 className="h-4 w-4" aria-hidden="true" />Undo the run</button>
        </div>}
      </li>
    })}</ul>
    <div role="status" aria-live="polite">{undo && !undo.finishedAt && <p className="mt-3 text-sm text-blue-700">{progressText(jobProgress(undo)!)}</p>}</div>
    {(error || result?.error) && <p role="alert" className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error || result?.error}</p>}
    {result?.result && <div className="mt-3 rounded-2xl bg-gray-50 p-4 text-sm text-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <strong className="font-medium">{result.result.results.filter(r => r.done).length} of {result.result.results.length} changes undone.</strong>
        <button type="button" className="text-xs text-blue-700 underline" onClick={() => clearJob(result.id)}>Dismiss</button>
      </div>
      {result.result.run && <p className="mt-1 text-xs">What could not be undone stays in the list; retry or fix it in Intune.</p>}
      <ul className="mt-2 max-h-48 space-y-0.5 overflow-auto text-xs">{result.result.results.map(r => <li key={`${r.action}${r.id}`} className={r.done ? "" : "text-red-800"}>{r.name}: {r.done ? (r.action === "removed" ? "deleted" : "previous version restored") : r.error}</li>)}</ul>
    </div>}
  </div>
}
