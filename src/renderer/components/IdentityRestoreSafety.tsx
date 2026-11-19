import { useEffect, useId, useRef, useState } from "react"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import type { ReplacedReference } from "../../shared/intune/restore-references"

interface SafetyRun { id: string; origin: string; entries: Array<{ key: string; folder: string; state: string; reason?: string; targetId?: string }>; replacedReferences?: ReplacedReference[]; referenceWarning?: string }
/** Mounted per tenant alongside the existing write history. No manual reset exists for guarded runs. */
export function IdentityRestoreSafety({ tenantId }: { tenantId: string }) {
  const id = useId()
  const [accounts, setAccounts] = useState("")
  const [saved, setSaved] = useState<string[]>([])
  const [runs, setRuns] = useState<SafetyRun[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const generation = useRef(0)
  const request = async (body: object) => {
    const current = ++generation.current
    setBusy(true)
    try {
      const response = await fetch("/api/restore-safety", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantId, ...body }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Restore safety could not be read.")
      if (!Array.isArray(data.accountIds) || !Array.isArray(data.runs)) throw new Error("Invalid restore safety response.")
      if (current !== generation.current) return
      setSaved(data.accountIds); setAccounts(data.accountIds.join("\n")); setRuns(data.runs); setError(""); setLoaded(true)
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  useEffect(() => { void request({ action: "list" }); return () => { generation.current++ } }, [tenantId])
  return <Card>
    <CardHeader><CardTitle>Identity restore safety</CardTitle><CardDescription>Entra ID and Defender remain backup-only. Review protected recovery accounts for this tenant and saved results from guarded restores.</CardDescription></CardHeader>
    <CardContent className="space-y-4" aria-busy={busy}>
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm">
        <p className="font-medium">Protected recovery accounts</p>
        <p>Use enabled cloud member accounts. The signed-in admin and the connected registration and enterprise app are always protected.</p>
        {loaded && <p className="mt-2 break-all" aria-live="polite">{saved.length ? saved.join(", ") : "No recovery accounts designated for this tenant."}</p>}
      </div>
      <label className="block space-y-1" htmlFor={id}><span className="text-sm font-medium">Recovery account object IDs, one per line</span>
        <textarea id={id} name="recoveryAccounts" autoComplete="off" spellCheck={false} className="min-h-24 w-full rounded-md border bg-background p-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={accounts} disabled={!loaded || busy} onChange={event => setAccounts(event.target.value)} />
      </label>
      <div data-no-select className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!loaded || busy} onClick={() => void request({ action: "save-recovery", accountIds: accounts.split(/[\s,]+/).filter(Boolean) })}>Save recovery accounts</Button>
        <Button variant="outline" disabled={busy} onClick={() => void request({ action: "list" })}>Refresh identity history</Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {loaded && !runs.length && <p className="text-sm text-muted-foreground">No guarded restore runs recorded.</p>}
      {runs.slice().reverse().map(run => <div key={run.id} className="space-y-2 border-t pt-3 text-sm">
        <p className="break-all font-medium">Restore {run.id} ({run.origin})</p>
        {run.entries.map(entry => <p key={entry.key} className="break-words">{entry.folder}: {entry.state}{entry.targetId ? ` (${entry.targetId})` : ""}{entry.reason ? `. ${entry.reason}` : ""}</p>)}
        {run.referenceWarning && <p>{run.referenceWarning}</p>}
        {run.replacedReferences?.map((reference, index) => <p key={index} className="break-all">Review {reference.path}, {reference.property}: {reference.mapping.kind} {reference.mapping.source} now maps to {reference.mapping.target}.</p>)}
        <div data-no-select><Button variant="outline" disabled={busy} onClick={() => void request({ action: "reconcile", runId: run.id })}>Read back saved outcome</Button></div>
        <p className="text-muted-foreground">Read-back never repeats a write. An absent or ambiguous match stays uncertain. Resume unsent steps from a reviewed restore.</p>
      </div>)}
    </CardContent>
  </Card>
}
