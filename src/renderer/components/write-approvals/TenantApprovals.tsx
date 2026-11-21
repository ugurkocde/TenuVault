import { useEffect, useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import { useTenants } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import type { WriteApprovalInbox } from "../../../shared/write-approvals"
import { WRITE_APPROVAL_NOTICE, type ApprovalNotice } from "../../lib/write-approvals"

export function TenantApprovals({ active, initialTenant, highlight = [] }: { active: boolean; initialTenant?: string; highlight?: string[] }) {
  const tenants = useTenants().filter(tenant => tenant.credentials?.tenantId)
  const [selected, setSelected] = useState(initialTenant)
  const tenant = tenants.find(value => value.credentials!.tenantId.toLowerCase() === selected?.toLowerCase()) ?? tenants[0]
  if (!tenant) return <p className="text-sm text-muted-foreground">Connect and sign in to a tenant to view approvals.</p>
  const id = tenant.credentials!.tenantId
  return <div className="space-y-4">
    <label className="flex flex-wrap items-center gap-2 text-sm">
      Approval tenant
      <select className="max-w-full rounded-md border bg-background px-3 py-2" value={id} onChange={event => setSelected(event.target.value)}>
        {tenants.map(value => <option key={value.id} value={value.credentials!.tenantId}>{value.name}</option>)}
      </select>
    </label>
    {active && <ApprovalInbox key={id} tenant={id} highlight={highlight} />}
  </div>
}

function ApprovalInbox({ tenant, highlight }: { tenant: string; highlight: string[] }) {
  const [inbox, setInbox] = useState<WriteApprovalInbox | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [closeRequest, setCloseRequest] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const generation = useRef(0)

  async function call(action = "list", requestId?: string) {
    const issued = ++generation.current
    setBusy(true)
    setError("")
    setNotice("")
    async function request(name: string) {
      const response = await fetch("/api/tenant-write-approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: tenant, action: name, requestId, confirmManagedCutover: name === "enable", confirmReconciled: name === "close-interrupted" }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Tenant approvals could not be loaded.")
      return data as WriteApprovalInbox & { committed?: true }
    }
    try {
      const data = await request(action)
      if (issued !== generation.current) return
      if (data.committed) {
        try {
          const refreshed = await request("list")
          if (issued === generation.current) setInbox(refreshed)
        } catch {
          if (issued === generation.current) {
            setInbox(null)
            setNotice("Decision saved. Refresh approvals to reload the inbox.")
          }
        }
      } else setInbox(data)
    } catch (failure) {
      if (issued !== generation.current) return
      setError(failure instanceof Error ? failure.message : "Tenant approvals could not be loaded.")
      if (action !== "list") {
        try {
          const data = await request("list")
          if (issued === generation.current) setInbox(data)
        } catch { if (issued === generation.current) setInbox(null) }
      } else setInbox(null)
    } finally {
      if (issued === generation.current) setBusy(false)
    }
  }

  useEffect(() => {
    void call()
    return () => { generation.current++ }
    // The parent remounts this inbox when its tenant changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="space-y-4" aria-busy={busy}>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={busy} onClick={() => void call()}>Refresh approvals</Button>
      {inbox?.available && !inbox.enabled && <Button disabled={busy} onClick={() => setConfirm(true)}>Require a second admin</Button>}
      {inbox?.enabled && <Button variant="outline" disabled={busy} onClick={() => void call("disable")}>
        {inbox.requests.some(({ request, decision, expired, local, superseded, invalidDecisionTime }) => local && !invalidDecisionTime && !expired && !superseded && request.state === "pending" && request.summary.kind === "Disable tenant write approval" && decision?.decision === "approved")
          ? "Apply approved disable" : "Request to turn off"}
      </Button>}
    </div>
    {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {inbox && <p className="text-sm text-muted-foreground">
      {!inbox.available ? "Use shared Azure storage to request approval from another admin."
        : inbox.enabled ? `On. This tenant requires TenuVault ${inbox.minimumVersion} or later.` : "Off for this tenant."}
    </p>}
    {inbox?.available && !inbox.requests.length && !inbox.invalidRecords && <p className="text-sm text-muted-foreground">No tenant approval requests.</p>}
    {!!inbox?.invalidRecords && <p role="status" className="text-muted-foreground">{inbox.invalidRecords} approval records could not be read. Refresh to try again.</p>}
    {!!inbox?.requests.length && <ul className="divide-y rounded-lg border">
      {inbox.requests.map(({ request, decision, expired, local, superseded, invalidDecisionTime }) => {
        const owner = request.requester.oid === inbox.actor?.oid
        const open = request.state === "pending" && !expired && !superseded
        const blocker = request.state === "claimed" ? "The apply is running or its outcome needs verification in Intune."
          : request.state === "stale" ? "The source, options or destination changed. Request approval again."
          : request.state === "interrupted" ? "Review any changes in Intune before requesting a new approval."
          : request.state !== "pending" ? null
          : invalidDecisionTime ? "The decision predates this request. Cancel it and request approval again."
          : expired ? "This request expired." : superseded ? "The policy generation changed."
          : decision?.decision === "approved" && owner ? local ? "Return to the operation and apply the same reviewed selection." : "Apply from the installation that requested approval." : null
        return <li key={request.id} className={`space-y-2 break-words p-4 text-sm ${highlight.includes(request.id) ? "bg-blue-50" : ""}`}>
          <p className="font-medium">{request.summary.kind} ({request.summary.count})</p>
          <p className="text-muted-foreground">Request ID <span className="break-all font-mono">{request.id}</span></p>
          {request.summary.reference && <p className="break-all text-muted-foreground">Source or operation reference {request.summary.reference}</p>}
          <p>Requester {request.requester.label} <span className="break-all text-muted-foreground">({request.requester.oid})</span></p>
          <p>Decision {invalidDecisionTime ? "invalid timestamp" : decision ? `${decision.decision} by ${decision.actor.label} (${decision.actor.oid})` : "pending"} · Status {request.state} · Expires {new Date(request.expiresAt).toLocaleString()}</p>
          {!!request.summary.targets.length && <details><summary className="cursor-pointer">Review targets and affected fields</summary>
            <ul className="list-disc space-y-1 break-all pl-5">{request.summary.operations?.length
              ? request.summary.operations.map(({ name, id, verb, assignments, fields, sensitiveFields }, index) => <li key={index}>
                {verb && `${verb} `}{name}{id && ` (${id})`}
                {!!assignments.length && <p>{assignments.join(", ")}</p>}
                {!!fields.length && <p>Affected fields {fields.join(", ")}</p>}
                {!!sensitiveFields.length && <p>Sensitive fields {sensitiveFields.join(", ")}</p>}
              </li>)
              : request.summary.targets.map((target, index) => <li key={index}>{target}</li>)}</ul>
            <p>Assignments {request.summary.assignments ? "included" : "unchanged or unassigned"}</p>
            {!!request.summary.fields?.length && <p>Affected fields {request.summary.fields.join(", ")}</p>}
            {!!request.summary.mappings?.length && <ul className="list-disc space-y-1 break-all pl-5">{request.summary.mappings.map(mapping => <li key={mapping.sourceId}>{mapping.folder} from {mapping.sourceId} to {mapping.targetId}</li>)}</ul>}
          </details>}
          {blocker && <p className="text-muted-foreground">{blocker}</p>}
          {request.state === "claimed" && owner && local && <Button variant="outline" size="sm" disabled={busy} onClick={() => setCloseRequest(request.id)}>Close interrupted apply</Button>}
          {open && <div className="flex flex-wrap gap-2">
            {owner && <Button variant="outline" size="sm" disabled={busy} onClick={() => void call("cancel", request.id)}>Cancel request</Button>}
            {!owner && !decision && <>
              <Button size="sm" disabled={busy} onClick={() => void call("approve", request.id)}>Approve</Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void call("reject", request.id)}>Reject</Button>
            </>}
          </div>}
        </li>
      })}
    </ul>}
    <Dialog open={!!closeRequest} onOpenChange={value => { if (!value) setCloseRequest(undefined) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close interrupted apply?</DialogTitle>
          <DialogDescription>Check the outcome in Intune and, for a restore, reconcile any uncertain entry in Settings under restore write history. Closing this request consumes its approval. Any retry that writes to Intune needs a fresh review.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCloseRequest(undefined)}>Cancel</Button>
          <Button onClick={() => { const id = closeRequest; setCloseRequest(undefined); void call("close-interrupted", id) }}>I checked Intune</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={confirm} onOpenChange={setConfirm}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Require a second admin?</DialogTitle>
          <DialogDescription>Update every TenuVault installation that writes to this tenant to this version or later. Connect them all to this shared Azure storage account and finish or replace in-progress jobs before enabling approval.</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Older or unmanaged installations, the Intune admin center and other tools can still write to Intune. Anyone who can write to the backup container is trusted like an Intune admin.</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button onClick={() => { setConfirm(false); void call("enable") }}>Confirm cutover and enable</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

export function TenantApprovalSettings({ active }: { active: boolean }) {
  return <Card id="tenant-approvals">
    <CardHeader><CardTitle>Tenant approvals</CardTitle><CardDescription>Require a second signed-in admin to approve changes to this tenant.</CardDescription></CardHeader>
    <CardContent><TenantApprovals active={active} /></CardContent>
  </Card>
}

export function WriteApprovalNotice() {
  const location = useLocation()
  const [notice, setNotice] = useState<ApprovalNotice | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setNotice(null)
    setOpen(false)
    const receive = (event: Event) => { setNotice((event as CustomEvent<ApprovalNotice>).detail) }
    window.addEventListener(WRITE_APPROVAL_NOTICE, receive)
    return () => window.removeEventListener(WRITE_APPROVAL_NOTICE, receive)
  }, [location.key])
  if (!notice) return null
  return <>
    <div role="status" className="mx-6 mt-4 flex flex-wrap items-center gap-3 rounded-lg border bg-blue-50 p-3 text-sm">
      <span className="min-w-0 flex-1 break-words">{notice.message}</span>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Open Tenant approvals</Button>
      <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Tenant approvals</DialogTitle><DialogDescription>Check the decision and expiry before you return to the operation.</DialogDescription></DialogHeader>
        <TenantApprovals active={open} initialTenant={notice.tenant} highlight={notice.ids} />
      </DialogContent>
    </Dialog>
  </>
}
