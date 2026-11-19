"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "~/components/ui/button"
import type { BackupTenant } from "./types"
import type { DirectoryReview } from "../../../main/restore/directory-9a"

interface Review { runId: string; fingerprint: string; more: boolean; rows: Array<{ key: string; review: DirectoryReview }> }
const approvalLabel: Record<string, string> = { "directory-item": "Approve this individual change", "privileged-relationship": "Approve this privileged relationship", "security-response": "Approve undoing the apparent security response", "recycle-relationships": "Approve recovered relationships and account state", "exact-group": "Approve this removal for this group" }
/** A bounded page of explicit approvals, outside restore all and row selection. */
export function DirectoryRestore({ tenant, backupId, path }: { tenant: BackupTenant; backupId: string; path: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [stage, setStage] = useState("object"), [exactMembers, setExactMembers] = useState(false), [exactOwners, setExactOwners] = useState(false)
  const [review, setReview] = useState<Review | null>(null), [approvals, setApprovals] = useState<Record<string, string[]>>({}), [message, setMessage] = useState("")
  const [outcomes, setOutcomes] = useState<Array<{ key: string; state: string; reason?: string; targetId?: string }>>([])
  const [resumeId, setResumeId] = useState("")
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [tenant.credentials.tenantId, tenant.credentials.appId, backupId, path])
  const invalidate = () => { generation.current++; setReview(null); setApprovals({}); setOutcomes([]); setMessage("") }
  const send = async (action: "preview" | "restore" | "cancel" | "resume" | "next") => {
    const run = action === "cancel" ? generation.current : ++generation.current
    if (action !== "cancel") setBusy(true)
    setMessage("")
    try {
      const response = await fetch("/api/restore-directory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...tenant.credentials, storageAccountName: tenant.storageAccountName, backupId, path, action: action === "next" ? "preview" : action, ...(action === "next" ? { previousRunId: review?.runId } : {}), stage, exactMembers, exactOwners, approvals, runId: action === "resume" ? resumeId : review?.runId, fingerprint: review?.fingerprint, mode: "replace", restoreType: "selective", selectedPolicies: [path] }) })
      const data = await response.json()
      if (generation.current !== run) return
      if (!response.ok) throw new Error(data.error ?? "Directory restore could not finish.")
      if (action === "preview" || action === "resume" || action === "next") { setReview(data); if (data.options) { setStage(data.options.stage); setExactMembers(data.options.exactMembers); setExactOwners(data.options.exactOwners) } setApprovals({}); setOutcomes([]); setMessage(data.rows.length ? "Review each row separately." : "No relationship differences remain in this page.") }
      else if (action === "cancel") setMessage("Cancellation requested. In-flight writes are reconciled before a retry.")
      else { setOutcomes(data.outcomes ?? []); setMessage(data.status === "complete" ? "Directory page completed. Preview again for remaining differences." : `Directory restore is partial. Applied changes are retained. Review the results and warnings. Resume unanswered steps with the same approvals. ${(data.warnings ?? []).join(" ")}`) }
    } catch (error) { if (generation.current === run) setMessage(error instanceof Error ? error.message : "Directory restore could not finish.") }
    finally { if (action !== "cancel" && generation.current === run) setBusy(false) }
  }
  const selected = review?.rows.some(row => !row.review.blocker && row.review.approvals.every(kind => approvals[row.key]?.includes(kind)))
  return <div className="px-4 pb-3 pl-11 text-sm" data-no-select>
    <Button size="sm" variant="outline" disabled={busy} aria-expanded={open} onClick={() => { setOpen(!open); invalidate() }}>Review directory restore</Button>
    {open && <div className="mt-2 space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-gray-900">
      <p>Review who receives access. Each change needs its own approval and is never part of restore all. Recreated objects get a new ID. Restore the object before reviewing relationships.</p>
      <p>Object updates restore a user's display name or a security group's description. Other profile and group properties have no admitted restore round trip.</p>
      <p>Account activation, recycle recovery, invitations, licenses, dynamic rules, role-assignable groups and nested group principals remain blocked. Their live evidence or privileged safety integration is incomplete.</p>
      <label className="block">Review <select className="ml-2 rounded border bg-white p-1 text-gray-900" disabled={busy} value={stage} onChange={event => { setStage(event.target.value); invalidate() }}><option value="object">Directory object</option><option value="relationships">Relationships</option></select></label>
      {path.split("/")[1] === "Groups" && stage === "relationships" && <>
        <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={exactMembers} onChange={event => { setExactMembers(event.target.checked); invalidate() }} />Exact membership for this group, remove members absent from the backup</label>
        <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={exactOwners} onChange={event => { setExactOwners(event.target.checked); invalidate() }} />Exact ownership for this group, remove owners absent from the backup</label>
      </>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void send("preview")}>Preview directory changes</Button>
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-0">Saved page ID<input className="block w-full rounded border bg-white p-1 text-gray-900" disabled={busy} value={resumeId} onChange={event => setResumeId(event.target.value)} /></label><Button size="sm" variant="outline" disabled={busy || !resumeId} onClick={() => void send("resume")}>Resume saved page</Button></div>
      {review && <><p>Saved page: <span className="break-all">{review.runId}</span>. Up to 50 changes per page, executed in batches of 20.</p>
        <div className="max-h-96 space-y-3 overflow-auto">{review.rows.map(({ key, review: row }) => <div key={key} className="space-y-2 rounded border bg-white p-3 text-gray-900">
          <p className="break-words"><strong>{row.principal ? `${row.principal.name} (${row.principal.type})` : row.resource.name}</strong>: {row.privilege} on {row.resource.name} ({row.resource.type})</p>
          <p className="break-all">Scope: {row.scope}</p>
          {row.notices.map(notice => <p key={notice}>{notice}</p>)}
          {row.changes.map(change => <div key={change.property} className="break-all"><strong>{change.property}</strong><p>Current: {JSON.stringify(change.before)}</p><p>Restore: {JSON.stringify(change.after)}</p></div>)}
          {row.blocker ? <p role="status">Blocked: {row.blocker}</p> : row.approvals.map(kind => <label key={kind} className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={approvals[key]?.includes(kind) ?? false} onChange={event => setApprovals(previous => ({ ...previous, [key]: event.target.checked ? [...(previous[key] ?? []), kind] : (previous[key] ?? []).filter(value => value !== kind) }))} />{approvalLabel[kind] ?? kind}</label>)}
        </div>)}</div>
        {review.more && <div className="space-y-2"><p>More changes remain. Completed differences are omitted. Blocked rows do not prevent reviewing the next page.</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void send("next")}>Preview next page</Button></div>}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !selected} onClick={() => void send("restore")}>Execute approved changes or resume page</Button>{busy && <Button size="sm" variant="outline" onClick={() => void send("cancel")}>Cancel directory restore</Button>}</div>
      </>}
      {outcomes.length > 0 && <div className="max-h-64 space-y-2 overflow-auto" aria-label="Directory page results">{outcomes.map(outcome => <p key={outcome.key} className="break-all">{review?.rows.find(row => row.key === outcome.key)?.review.privilege ?? "Change"}: {outcome.state}. {outcome.targetId && <>Target ID: {outcome.targetId}. </>}{outcome.reason}</p>)}</div>}
      <p role="status" aria-live="polite">{message}</p>
    </div>}
  </div>
}
