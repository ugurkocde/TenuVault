import { useCallback, useEffect, useRef, useState } from "react"
import { HardDriveDownload, RefreshCw } from "lucide-react"
import { Button } from "~/components/ui/button"
import type { AppAssignmentCheck } from "../../../shared/app-sources/types"
import { bridge } from "../../lib/bridge"

const labels = { included: "Includes this PC", excluded: "Excludes this PC", "not-member": "No reported device membership", user: "User targeting", unknown: "Needs review" }

export function AssignmentCheckPanel({ tenant, appId, busy, onCapture }: { tenant: string; appId: string; busy: boolean; onCapture?: (appId: string) => Promise<boolean> }) {
  const [check, setCheck] = useState<AppAssignmentCheck | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [refreshed, setRefreshed] = useState(false)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const current = ++generation.current
    setLoading(true); setCheck(null); setError("")
    try {
      const value = await bridge.appSources.assignments(tenant, appId)
      if (current === generation.current) {
        if (value.appId !== appId) throw new Error("The assignment result did not match this app. Recheck assignments.")
        setCheck(value)
      }
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : "Assignments could not be checked. Review them in Intune.") }
    finally { if (current === generation.current) setLoading(false) }
  }, [tenant, appId])
  useEffect(() => { void load(); return () => { generation.current++ } }, [load])
  async function start() {
    if (busy || loading) return
    if (check && (!Number.isFinite(Date.parse(check.checkedAt)) || Date.now() - Date.parse(check.checkedAt) > 60_000)) {
      setRefreshed(true); await load(); return
    }
    void onCapture?.(appId)
  }
  return <div className="mt-5 space-y-4">
    <section className="rounded-xl border bg-card p-4" aria-label="Assignment check">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-semibold">Assignment check for this PC</h4>
        <Button variant="outline" size="sm" disabled={loading || busy} onClick={() => { setRefreshed(false); void load() }}><RefreshCw className="mr-2 size-4" aria-hidden="true"/>Recheck assignments</Button>
      </div>
      <div role="status" className="mt-3 space-y-2 text-sm">
        {loading ? <p>Checking Intune assignments and this PC’s targeting…</p> : error ? <p>{error} You can review assignments in Intune or let Intune check access when Backup starts.</p> : check ? <>
          <p className="font-medium">{check.summary}</p>
          {refreshed && <p>The check was refreshed. Review the result, then start backup.</p>}
          {check.steps.length > 0 && <ul className="list-disc space-y-2 pl-5">{check.steps.map(step => <li key={step}>{step}</li>)}</ul>}
          {check.warnings.map(warning => <p key={warning} className="text-muted-foreground">{warning}</p>)}
          {check.assignments.length > 0 && <details className="pt-2"><summary className="cursor-pointer rounded font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">View {check.assignments.length} assignment{check.assignments.length === 1 ? "" : "s"}</summary>
            <ul className="mt-3 divide-y">{check.assignments.map(row => <li key={row.id} className="space-y-1 py-3 [overflow-wrap:anywhere]">
              <p className="font-medium">{row.intent} · {row.target}</p><p>{labels[row.match]}. {row.detail}</p>
              {row.filter && <><p>Filter: {row.filter.name} ({row.filter.mode})</p>{row.filter.rule && <pre className="whitespace-pre-wrap rounded bg-secondary p-2 text-xs">{row.filter.rule}</pre>}</>}
            </li>)}</ul>
          </details>}
          <p className="pt-2 text-xs text-muted-foreground">Checked {new Date(check.checkedAt).toLocaleTimeString()}. This is targeting guidance; Intune confirms installer access when Backup starts.</p>
        </> : null}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">No assignments are changed here. Required assignments can install the app automatically; use a dedicated test-device group for intended changes.</p>
    </section>
    <Button disabled={busy || loading || !onCapture} onClick={() => void start()}><HardDriveDownload className="mr-2 size-4" aria-hidden="true"/>{busy ? "Backing up…" : "Start backup"}</Button>
  </div>
}
