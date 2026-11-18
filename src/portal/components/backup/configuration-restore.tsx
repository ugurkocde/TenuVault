"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "~/components/ui/button"
import type { BackupTenant } from "./types"

interface Review { runId: string; fingerprint: string; kind: string; changes: Array<{ property: string; before: unknown; after: unknown }> }
/** Separate from selection and restore all: each policy gets its own reviewed run. */
export function ConfigurationRestore({ tenant, backupId, path, singleton }: { tenant: BackupTenant; backupId: string; path: string; singleton: boolean }) {
  const [open, setOpen] = useState(false)
  const [operation, setOperation] = useState<"create" | "update">("update")
  const [allowRemoval, setAllowRemoval] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const hintOnly = path.split("/")[1] === "EntraCompanyBranding"
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const send = async (action: "preview" | "restore") => {
    const run = ++generation.current
    setBusy(true); setMessage("")
    try {
      const response = await fetch("/api/restore-configuration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...tenant.credentials, storageAccountName: tenant.storageAccountName, backupId, path, action, operation, mode: operation === "update" ? "replace" : "copy", restoreType: "selective", selectedPolicies: [path], allowRemoval, ...(action === "restore" ? { runId: review?.runId, fingerprint: review?.fingerprint } : {}) }) })
      const data = await response.json()
      if (generation.current !== run) return
      if (!response.ok) throw new Error(data.error ?? "This restore could not finish.")
      if (action === "preview") setReview(data)
      else { setReview(null); setMessage(data.success ? "Restore completed. The saved result is in Storage and recovery." : data.error ?? "Restore is partial. Review the saved result in Storage and recovery.") }
    } catch (error) { if (generation.current === run) { setReview(null); setMessage(error instanceof Error ? error.message : "This restore could not finish.") } }
    finally { if (generation.current === run) setBusy(false) }
  }
  return <div className="px-4 pb-3 pl-11 text-sm" data-no-select>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => { setOpen(!open); setReview(null) }}>Review this configuration</Button>
    {open && <div className="mt-2 space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-gray-900">
      <p>This policy requires its own confirmation. It is never part of restore all. Review every change before continuing.</p>
      {hintOnly && <p>Only the default username hint is restored. Other branding properties and localizations stay as configured.</p>}
      {!singleton && <label className="block">Operation <select className="ml-2 rounded border bg-white p-1 text-gray-900" value={operation} disabled={busy} onChange={event => { setOperation(event.target.value as "create" | "update"); setReview(null) }}><option value="update">Replace the existing policy</option><option value="create">Recreate a missing policy</option></select></label>}
      <label className="flex items-start gap-2"><input type="checkbox" checked={allowRemoval} disabled={busy} onChange={event => { setAllowRemoval(event.target.checked); setReview(null) }} />Allow removal of collection entries for this policy only</label>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void send("preview")}>{busy ? "Working..." : "Preview exact changes"}</Button>
      {review && <><p>Confirmation: {review.kind}. {review.changes.length} {review.changes.length === 1 ? "property changes" : "properties change"}.</p><div className="max-h-72 space-y-2 overflow-auto">{review.changes.map(change => <div key={change.property}><strong>{change.property}</strong><p className="break-all">Current: {JSON.stringify(change.before)}</p><p className="break-all">Restore: {JSON.stringify(change.after)}</p></div>)}</div><Button size="sm" disabled={busy} onClick={() => void send("restore")}>Confirm and restore this policy</Button></>}
      <p role="status" aria-live="polite">{message}</p>
    </div>}
  </div>
}
