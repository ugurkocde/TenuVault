"use client"

import type { RestoreOutcome } from "~/lib/policies/graph-restore"

import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { TENANT_ADMIN, inTenant } from "../../../shared/intune/admin-links"
import type { BackupTenant } from "./types"

interface ApprovalRow {
  id: string
  label: string
  operation: string
  status: string
  approverNote?: string
  expiresAt?: string
  stepNumber: number
  totalSteps: number
  canComplete: boolean
  requesterName?: string
}
const STATUS_LABELS: Record<string, string> = {
  needsApproval: "Waiting for approval", approved: "Approved, ready to complete", rejected: "Rejected",
  cancelled: "Withdrawn", expired: "Expired", completed: "Completed", stale: "Changed since submission",
  "justification-required": "Not submitted yet",
}
const OPERATION_LABELS: Record<string, string> = { create: "Create", update: "Update", assign: "Assignments", delete: "Delete" }

export function RestoreApprovals({ tenant, revision = 0, openRevision = 0, enabled = false, onOutcome }: { tenant: BackupTenant; enabled?: boolean; revision?: number; openRevision?: number; onOutcome?: (outcome: RestoreOutcome) => void }) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (openRevision > 0) setOpen(true) }, [openRevision])
  const [records, setRecords] = useState<ApprovalRow[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [justification, setJustification] = useState("")
  const call = async (approvalAction: string, approvalId?: string, refresh = false) => {
    const response = await fetch("/api/restore-backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...tenant.credentials, storageAccountName: tenant.storageAccountName, approvalAction, approvalId, refresh, justification }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? "Could not update approvals")
    return data
  }
  const refresh = async () => {
    setBusy(true)
    try { setRecords((await call("list", undefined, true)).records ?? []); setError("") }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    setError("")
    if (!open) return
    let active = true
    const load = () => { if (document.visibilityState === "hidden") return; void call("list", undefined, true).then(data => { if (active) setRecords(data.records ?? []) }).catch(error => { if (active) setError(String(error.message)) }) }
    load()
    const timer = setInterval(load, 60_000)
    return () => { active = false; clearInterval(timer) }
  }, [open, tenant.credentials.tenantId])
  useEffect(() => {
    let active = true
    void call("list").then(data => { if (active) setRecords(data.records ?? []) }).catch(() => {})
    return () => { active = false }
  }, [revision, tenant.credentials.tenantId])
  const act = async (action: string, id: string) => {
    setBusy(true)
    try { const data = await call(action, id); if (data.outcome) onOutcome?.(data.outcome); await refresh(); if (data.outcome?.error) setError(data.outcome.error) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  if (!enabled && !records.length) return null
  return <section id="restore-approval-list" className="rounded-xl border bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>Waiting for approval</Button>
      <a className="text-sm underline" href={inTenant(TENANT_ADMIN("multiAdminApproval").url, tenant.credentials.tenantId)} target="_blank" rel="noreferrer">Open Multi Admin Approval in Intune</a>
    </div>
    {open && <div className="mt-3 space-y-3" aria-live="polite">
      <Button variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh</Button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!records.length && <p className="text-sm text-gray-500">No saved approval requests for this tenant.</p>}
      {records.some(record => record.status === "justification-required") && <label className="block text-sm">Justification<textarea className="mt-1 block w-full rounded border p-2" name="justification" autoComplete="off" maxLength={700} value={justification} onChange={event => setJustification(event.target.value)} /></label>}
      <ul className="divide-y">{records.map(record => <li key={record.id} className="space-y-2 break-words py-3 text-sm">
        <p className="font-medium">{record.label}</p>
        <p>{OPERATION_LABELS[record.operation] ?? record.operation}, Step {record.stepNumber} of {record.totalSteps}: {STATUS_LABELS[record.status] ?? record.status}</p>
        {record.approverNote && <p>Approver note: {record.approverNote}</p>}
        {record.expiresAt && ["needsApproval", "approved"].includes(record.status) && <p title={record.expiresAt}>{Math.max(0, Math.ceil((Date.parse(record.expiresAt) - Date.now()) / 3_600_000))} hours left</p>}
        {record.requesterName && <p>Requester: {record.requesterName}</p>}
        {!record.canComplete && <p>The original requester ({record.requesterName ?? "signed-in requester"}) must complete or withdraw this request.</p>}
        <div className="flex flex-wrap gap-2">
          {record.status === "approved" && record.canComplete && <Button disabled={busy} onClick={() => void act("complete", record.id)}>Complete</Button>}
          {record.status === "justification-required" && record.canComplete && <Button disabled={busy || !justification.trim()} onClick={() => void act("submit", record.id)}>Submit for approval</Button>}
          {["needsApproval", "approved", "stale"].includes(record.status) && record.canComplete && <Button variant="outline" disabled={busy} onClick={() => void act("withdraw", record.id)}>Withdraw</Button>}
          {["justification-required", "stale", "rejected", "cancelled", "expired", "completed"].includes(record.status) && (record.canComplete || record.status === "justification-required") && <Button variant="outline" disabled={busy} onClick={() => void act("dismiss", record.id)}>Dismiss</Button>}
        </div>
      </li>)}</ul>
    </div>}
  </section>
}
