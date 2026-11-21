"use client"

import { useEffect, useRef, useState } from "react"
import { bridge } from "../../../renderer/lib/bridge"
import { Button } from "~/components/ui/button"
import type { BackupTenant } from "./types"
import type { ReplacedReference } from "../../../shared/intune/restore-references"
import type { DirectoryOptions } from "../../../main/restore/directory-service"
import type { DirectoryReview } from "../../../main/restore/directory-9a"
import { directoryPageUnresolved } from "../../../shared/intune/directory-page-state"

interface Review { options?: DirectoryOptions; runId: string; fingerprint: string; more: boolean; discarded?: boolean; unresolved?: boolean; selection?: string[]; rows: Array<{ key: string; review: DirectoryReview }> }
const approvalLabel: Record<string, string> = { "directory-item": "Approve this individual change", "privileged-relationship": "Approve this privileged relationship", "security-response": "Approve undoing the apparent security response", "recycle-relationships": "Approve recovered relationships and account state", "exact-group": "Approve this removal for this group" }
/** A bounded page of explicit approvals, outside restore all and row selection. */
export function DirectoryRestore({ tenant, backupId = "", path = "" }: { tenant: BackupTenant; backupId?: string; path?: string }) {
  const savedOnly = !backupId || !path
  const [open, setOpen] = useState(savedOnly), [busy, setBusy] = useState(false)
  const [stage, setStage] = useState("object"), [exactMembers, setExactMembers] = useState(false), [exactOwners, setExactOwners] = useState(false)
  const [review, setReview] = useState<Review | null>(null), [approvals, setApprovals] = useState<Record<string, string[]>>({}), [message, setMessage] = useState("")
  const [references, setReferences] = useState<ReplacedReference[]>([])
  const [outcomes, setOutcomes] = useState<Array<{ key: string; state: string; reason?: string; targetId?: string; retryAt?: number }>>([])
  const [canDiscard, setCanDiscard] = useState<boolean | null>(null)
  const [resumeId, setResumeId] = useState("")
  const [activeRestore, setActiveRestore] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    const clear = () => {
      generation.current++; setActiveRestore(null); setBusy(false); setCanDiscard(null); setReview(null); setApprovals({}); setOutcomes([]); setReferences([]); setMessage(""); setResumeId("")
      setStage("object"); setExactMembers(false); setExactOwners(false)
    }
    clear()
    const unsubscribe = bridge.auth?.onAccountsChanged?.(changed => { if (changed.toLowerCase() === tenant.credentials.tenantId.toLowerCase()) clear() })
    return () => { generation.current++; unsubscribe?.() }
  }, [tenant.credentials.tenantId, tenant.credentials.appId, backupId, path])
  const invalidate = () => { generation.current++; setCanDiscard(null); setReview(null); setApprovals({}); setOutcomes([]); setReferences([]); setMessage("") }
  const send = async (action: "preview" | "restore" | "cancel" | "resume" | "next" | "reconcile" | "discard") => {
    const run = action === "cancel" ? generation.current : ++generation.current
    const pageId = action === "resume" ? resumeId : action === "cancel" ? activeRestore : action === "reconcile" || action === "discard" ? (review?.runId ?? resumeId) : review?.runId
    if (action !== "cancel") { setBusy(true); setActiveRestore(action === "restore" ? pageId ?? null : null) }
    if (action === "restore") { setOutcomes([]); setReview(previous => previous && { ...previous, selection: previous.rows.filter(row => !row.review.blocker && row.review.approvals.every(kind => approvals[row.key]?.includes(kind))).map(row => row.key), unresolved: true }) }
    setMessage("")
    try {
      const response = await fetch("/api/restore-directory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...tenant.credentials, storageAccountName: tenant.storageAccountName, backupId, path, action: action === "next" ? "preview" : action, ...(action === "next" ? { ...(review?.options ?? { stage, exactMembers, exactOwners }), previousRunId: review?.runId } : { stage, exactMembers, exactOwners }), approvals, runId: pageId, fingerprint: review?.fingerprint, mode: "replace", restoreType: "selective", selectedPolicies: [path] }) })
      const data = await response.json()
      if (generation.current !== run) return
      if (!response.ok) throw new Error(data.error ?? "Directory restore could not finish.")
      if (data.cancelled === true && action !== "cancel") {
        if (pageId) setResumeId(pageId)
        setCanDiscard(null); setReview(null); setApprovals({}); setOutcomes([]); setReferences([])
        setMessage("Directory restore cancelled. No further changes will be sent. Confirm any previously sent results before continuing.")
        return
      }
      if (data.rows && data.runId) setResumeId(data.runId)
      if (data.rows && data.options) { setStage(data.options.stage); setExactMembers(data.options.exactMembers); setExactOwners(data.options.exactOwners) }
      setCanDiscard(data.canDiscard === true)
      if (action === "restore" || action === "reconcile" || action === "discard") setReview(previous => {
        const current: Review | null = data.rows ? data : previous
        if (!current) return null
        const discarded = data.discarded ?? current.discarded ?? false
        return { ...current, discarded, unresolved: discarded ? false : data.unresolved ?? directoryPageUnresolved(false, current.selection ?? (data.outcomes ?? []).map((row: { key: string }) => row.key), data.outcomes ?? []) }
      })
      if (action === "preview" || action === "resume" || action === "next") { setReview(data); setApprovals(action === "resume" ? Object.fromEntries((data.rows as Review["rows"]).filter(row => data.selection?.includes(row.key)).map(row => [row.key, row.review.approvals])) : {}); setOutcomes([]); setReferences([]); setMessage(data.rows.length ? "Review each row separately." : "No relationship differences remain in this page.") }
      else if (action === "cancel") setMessage(data.cancelled ? "Cancellation requested. In-flight results will be confirmed before continuing." : "No active restore was cancelled.")
      else if (action === "discard") { setCanDiscard(false); setOutcomes([]); setMessage("Saved restore discarded. This page can never send again.") }
      else { setOutcomes(data.outcomes ?? []); setReferences(data.replacedReferences ?? []); setMessage(data.status === "nothing-sent" ? "No directory changes were sent for this page. You can discard the saved restore." : data.status === "complete" ? "Directory page completed. Preview again for remaining differences." : `Directory restore is partial. Applied changes are retained. Review the results and warnings. Resume throttled steps after the retry time. Confirm uncertain results before continuing. ${(data.warnings ?? []).join(" ")}`) }
    } catch (error) { if (generation.current === run) setMessage(error instanceof Error ? error.message : "Directory restore could not finish.") }
    finally { if (action !== "cancel" && generation.current === run) { setBusy(false); setActiveRestore(null) } }
  }
  const resultRows = outcomes.length > 0 && <div className="max-h-64 space-y-2 overflow-auto" aria-label="Directory page results">{outcomes.map(outcome => <p key={outcome.key} className="break-all">{review?.rows.find(row => row.key === outcome.key)?.review.privilege ?? "Change"}: {outcome.state === "deferred" ? (outcome.retryAt ? `Throttled by Microsoft Graph. Earliest retry: ${new Date(outcome.retryAt).toLocaleString()}.` : "Deferred before dispatch. Resume to continue.") : outcome.state === "uncertain" ? `The result is being confirmed.${outcome.retryAt ? ` Earliest retry: ${new Date(outcome.retryAt).toLocaleString()}.` : ""}` : `${outcome.state}.`} {outcome.targetId && <>Target ID: {outcome.targetId}. </>}{outcome.reason}</p>)}</div>
  if (savedOnly) return <div className="my-4 space-y-3 rounded-lg border p-4 text-sm">
    <p className="font-medium">Saved directory restores</p>
    <p>Confirm saved results even when the backup has been deleted. Confirmation only reads Microsoft Graph. Discard is available after every uncertain result is resolved and never undoes applied changes.</p>
    <div className="flex flex-wrap items-end gap-2"><label>Saved directory page ID<input className="block w-full rounded border bg-card p-1" disabled={busy} value={resumeId} onChange={event => { invalidate(); setResumeId(event.target.value) }} /></label><Button size="sm" variant="outline" disabled={busy || !resumeId} onClick={() => void send("reconcile")}>Confirm saved page results</Button>{(review?.runId ?? resumeId) && canDiscard !== false && <Button size="sm" variant="outline" disabled={busy} onClick={() => void send("discard")}>Discard saved restore</Button>}</div>
    {resultRows}<p role="status" aria-live="polite">{message}</p>
  </div>
  const applications = ["Applications", "ServicePrincipals", "OAuth2PermissionGrants"].includes(path.split("/")[1]!)
  const selected = review?.rows.some(row => !row.review.blocker && row.review.approvals.every(kind => approvals[row.key]?.includes(kind)))
  const unresolved = review?.discarded ? false : review?.unresolved ?? directoryPageUnresolved(false, review?.selection ?? outcomes.map(row => row.key), outcomes)
  return <div className="px-4 pb-3 pl-11 text-sm" data-no-select>
    <Button size="sm" variant="outline" disabled={busy} aria-expanded={open} onClick={() => { setOpen(!open); invalidate() }}>Review directory restore</Button>
    {open && <div className="mt-2 space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-gray-900">
      <p>Review who receives access. Each change needs its own approval and is never part of restore all. {!applications && <>Recreated objects get a new ID. Restore the object before reviewing relationships.</>}</p>
      {applications ? <p>Only nonempty app registration name and description updates run. Everything else is blocked, including creation, enterprise app metadata, recycle recovery, owners, consent, app roles, policy bindings, SAML signing keys, provisioning secrets and all credentials.</p> : <><p>Object updates restore a user's display name or a security group's nonempty description. Clearing descriptions remains blocked after inconsistent live read-back. Other profile and group properties have no admitted restore round trip.</p>
      <p>Exact member removal is blocked for Conditional Access targeted groups because it can affect policy enforcement. Remove those members in Microsoft Entra. Other admitted changes remain available.</p>
      <p>Account activation, recycle recovery, invitations, licenses, dynamic rules, role-assignable groups and nested group relationships remain blocked. Their live evidence or privileged safety integration is incomplete.</p></>}
      <label className="block">Review <select className="ml-2 rounded border bg-white p-1 text-gray-900" disabled={busy} value={stage} onChange={event => { setStage(event.target.value); invalidate() }}><option value="object">Directory object</option><option value="relationships">Relationships</option></select></label>
      {path.split("/")[1] === "Groups" && stage === "relationships" && <>
        <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={exactMembers} onChange={event => { setExactMembers(event.target.checked); invalidate() }} />Exact membership for this group, remove members absent from the backup</label>
        <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={exactOwners} onChange={event => { setExactOwners(event.target.checked); invalidate() }} />Exact ownership for this group, remove owners absent from the backup</label>
      </>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void send("preview")}>Preview directory changes</Button>
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-0">Saved page ID<input className="block w-full rounded border bg-white p-1 text-gray-900" disabled={busy} value={resumeId} onChange={event => setResumeId(event.target.value)} /></label><Button size="sm" variant="outline" disabled={busy || !resumeId} onClick={() => void send("resume")}>Resume saved page</Button><Button size="sm" variant="outline" disabled={busy || !(review?.runId ?? resumeId)} onClick={() => void send("reconcile")}>Confirm this page's results</Button>{(review?.runId ?? resumeId) && canDiscard !== false && <Button size="sm" variant="outline" disabled={busy} onClick={() => void send("discard")}>Discard saved restore</Button>}</div>
      {!review && resumeId && <p>Saved page: <span className="break-all">{resumeId}</span>. Discard checks the saved owner and refuses any uncertain result locally.</p>}
      {review && <><p>Saved page: <span className="break-all">{review.runId}</span>. Up to 50 changes per page, executed in batches of 20.</p>
        {review.discarded && <p>Saved restore discarded. This page can never send again.</p>}
        <div className="max-h-96 space-y-3 overflow-auto">{review.rows.map(({ key, review: row }) => <div key={key} className="space-y-2 rounded border bg-white p-3 text-gray-900">
          <p className="break-words"><strong>{row.principal ? `${row.principal.name} (${row.principal.type})` : row.resource.name}</strong>: {row.privilege} on {row.resource.name} ({row.resource.type})</p>
          <p className="break-all">Scope: {row.scope}</p>
          {row.notices.map(notice => <p key={notice}>{notice}</p>)}
          {row.changes.map(change => <div key={change.property} className="break-all"><strong>{change.property}</strong><p>Current: {JSON.stringify(change.before)}</p><p>Restore: {JSON.stringify(change.after)}</p></div>)}
          {row.blocker ? <p role="status">Blocked: {row.blocker}</p> : row.approvals.map(kind => <label key={kind} className="flex items-start gap-2"><input type="checkbox" disabled={busy || review.discarded} checked={approvals[key]?.includes(kind) ?? false} onChange={event => setApprovals(previous => ({ ...previous, [key]: event.target.checked ? [...(previous[key] ?? []), kind] : (previous[key] ?? []).filter(value => value !== kind) }))} />{approvalLabel[kind] ?? kind}</label>)}
        </div>)}</div>
        {review.more && <div className="space-y-2"><p>{unresolved ? "Resolve or discard this saved page before previewing the next page. Unresolved changes keep their objects locked." : "More changes remain. Completed differences are omitted. Blocked rows do not prevent reviewing the next page."}</p><Button size="sm" variant="outline" disabled={busy || unresolved} onClick={() => void send("next")}>Preview next page</Button></div>}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || review.discarded || !selected} onClick={() => void send("restore")}>Execute approved changes or resume page</Button>{busy && activeRestore === review.runId && <Button size="sm" variant="outline" onClick={() => void send("cancel")}>Cancel directory restore</Button>}</div>
      </>}
      {resultRows}
      {references.length > 0 && <div className="max-h-64 space-y-2 overflow-auto"><p>Policies that still reference old IDs need review:</p>{references.map((reference, index) => <p className="break-all" key={index}>{reference.path}, {reference.property}. Old ID: {reference.mapping.source}. New ID: {reference.mapping.target}.</p>)}</div>}
      <p role="status" aria-live="polite">{message}</p>
    </div>}
  </div>
}
