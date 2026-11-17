import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { INVALID_CONNECT_LINK, type PendingConnectLink } from "../../shared/deep-link"
import { bridge } from "../lib/bridge"
import { useConnectLinksHeld } from "../lib/connect-link-holds"
import { isBackupJobPollable } from "~/lib/backup-job-display"
import { requestOnboardingConnect } from "../lib/connect-link-onboarding"

export function ConnectLinkHost() {
  const [pending, setPending] = useState<PendingConnectLink | null>(null)
  const [rejected, setRejected] = useState(false)
  const [error, setError] = useState("")
  const continuing = useRef(false)
  const held = useConnectLinksHeld()
  const { activeJobs } = useBackupProgress()
  const tenants = useTenants()
  const { setSelectedTenantId } = useSelectedTenant()
  const navigate = useNavigate()
  const busy = held || activeJobs.some(isBackupJobPollable)

  useEffect(() => {
    let active = true
    let request = 0
    const take = async () => {
      const current = ++request
      try {
        const state = await bridge.connectLink.takePending()
        if (!active) return
        if (state.rejected) setRejected(true)
        if (current === request) setPending(state.pending)
      } catch { /* A failed IPC leaves the pending link in main for the next notification. */ }
    }
    const unsubscribe = bridge.connectLink.onAvailable(() => { void take() })
    void take()
    return () => { active = false; unsubscribe() }
  }, [])

  const connected = pending && tenants.find(tenant => tenant.credentials?.tenantId.toLowerCase() === pending.details.tenantId)
  const sameClient = connected && connected.credentials?.appId.toLowerCase() === pending?.details.clientId
  const dismiss = async () => {
    if (!pending) return
    await bridge.connectLink.dismiss(pending.id)
    setPending(current => current?.id === pending.id ? null : current)
    setError("")
  }
  const proceed = async () => {
    if (!pending || busy || continuing.current) return
    continuing.current = true
    try {
      await dismiss()
      if (connected) {
        setSelectedTenantId(connected.id)
        void navigate("/portal/dashboard")
      } else {
        requestOnboardingConnect(pending.details)
        void navigate("/portal/onboarding")
      }
    } catch { setError("Could not open this connection. Try again.") }
    finally { continuing.current = false }
  }

  const dismissRejection = () => {
    void bridge.connectLink.dismissRejection().then(() => setRejected(false)).catch(() => {})
  }

  return <>
    <Dialog open={rejected && !busy} onOpenChange={open => { if (!open) dismissRejection() }}>
      <DialogContent holdConnectLinks={false}>
        <DialogHeader><DialogTitle>{INVALID_CONNECT_LINK}</DialogTitle><DialogDescription>Ask the administrator for the complete link printed by the setup script.</DialogDescription></DialogHeader>
        <DialogFooter><Button onClick={dismissRejection}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(pending) && !rejected && !busy} onOpenChange={open => { if (!open) void dismiss().catch(() => setError("Could not dismiss this connection. Try again.")) }}>
      <DialogContent holdConnectLinks={false}>
        <DialogHeader><DialogTitle>Connect a tenant?</DialogTitle><DialogDescription>{connected ? "Open this tenant to use its saved connection." : "You sign in with Microsoft next. Nothing is saved until you do."}</DialogDescription></DialogHeader>
        {pending && <div className="space-y-3 break-words text-sm">
          {pending.details.displayName && <p className="font-medium">{pending.details.displayName}</p>}
          <p>Tenant ID: {pending.details.tenantId}</p>
          <p>Application (client) ID: {pending.details.clientId}</p>
          {connected && <>
            {!sameClient && <p>Saved application (client) ID: {connected.credentials?.appId}</p>}
            <p>{sameClient ? "This tenant is already connected with this app registration." : "This tenant is already connected with another app registration. To switch registrations, remove the tenant in TenuVault first, then open this link again."}</p>
          </>}
        </div>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => void dismiss().catch(() => setError("Could not dismiss this connection. Try again."))}>Cancel</Button>
          <Button onClick={() => void proceed()}>{connected ? "Open tenant" : "Continue to sign in"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
