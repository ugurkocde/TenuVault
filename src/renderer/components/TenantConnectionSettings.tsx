import { TenuVaultConsent } from "./TenuVaultConsent"
import type { PackConsentPlan } from "../../shared/pack-consent"
import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { GRAPH_CLI_CONSENT_WARNING, GRAPH_CLI_UNAVAILABLE, OWN_APP_UPGRADE, ORGANIZATION_RENEWAL_NOTICE, SIGN_IN_METHODS, type TenantConnection } from "../../shared/tenant-connection"
import { isGuid } from "../../shared/security"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"
import { toast } from "../lib/toast"

export function TenantConnectionSettings({ tenantId, clientId, initialPack, onChanged }: {
  tenantId: string
  clientId: string
  initialPack?: string
  onChanged: (clientId: string) => void
}) {
  const [connection, setConnection] = useState<TenantConnection | null>(null)
  const [consent, setConsent] = useState<PackConsentPlan | null>(null)
  const { status } = useLicense()
  const [open, setOpen] = useState(false)
  const [graphCli, setGraphCli] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [graphError, setGraphError] = useState<string>()
  const [nextClientId, setNextClientId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let current = true
    setConsent(null)
    void bridge.auth.connection(tenantId).then(async value => {
      if (!current) return
      setConnection(value)
      if (value?.origin === "wizard") {
        const [plan, available] = await Promise.all([
          bridge.auth.packConsentPlan?.(tenantId),
          bridge.auth.graphCliAvailable?.(),
        ])
        if (current) {
          setConsent(plan ?? null)
          setGraphCli(available === true)
        }
      }
    }).catch(() => undefined)
    return () => { current = false }
  }, [tenantId, clientId])

  const tenantLicense = status?.tenants.find(tenant => tenant.tenantId === tenantId.toLowerCase())

  const change = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const outcome = await bridge.auth.switchConnection(tenantId, { method: "ownApp", clientId: nextClientId.trim() })
      if ("error" in outcome) {
        setError(outcome.error.message)
        return
      }
      const { result } = outcome
      setGraphError(undefined)
      setConnection(result.connection)
      onChanged(result.connection.clientId)
      setOpen(false)
      toast(result.missing.length
        ? "App registration updated. Review missing permissions under Services and permissions."
        : "App registration updated.", "success")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The app registration could not be changed.")
    } finally {
      setBusy(false)
    }
  }

  const startNow = async () => {
    setBusy(true)
    setGraphError(undefined)
    try {
      const outcome = await bridge.auth.switchConnection(tenantId, { method: "graphCli" })
      if ("error" in outcome) {
        setGraphError(outcome.error.message)
        const fresh = await bridge.auth.packConsentPlan(tenantId).catch(() => null)
        setConsent(fresh)
      } else {
        setConnection(outcome.result.connection)
        onChanged(outcome.result.connection.clientId)
        toast("Signed in with Start now. Review backup coverage in Services and permissions.", "success")
      }
    } catch {
      setGraphError(GRAPH_CLI_UNAVAILABLE)
    } finally {
      setBusy(false)
      setGraphOpen(false)
    }
  }

  if (connection?.origin !== "wizard") return null
  const upgrade = connection.method === "graphCli" || Boolean(graphError)
  return (
    <div className="mt-2 flex scroll-mt-4 flex-wrap items-center gap-2">
      <p className="text-xs text-gray-500">Sign-in method: {SIGN_IN_METHODS[connection.method]}</p>
      <Button variant="outline" size="sm" onClick={() => { setNextClientId(""); setError(undefined); setOpen(true) }}>
        {upgrade ? OWN_APP_UPGRADE : "Change app registration"}
      </Button>
      {graphCli && connection.method !== "graphCli" && <Button variant="outline" size="sm" onClick={() => { setGraphError(undefined); setGraphOpen(true) }}>Use Start now</Button>}
      {graphError && <p role="alert" className="basis-full text-sm text-destructive">{graphError}</p>}
      {consent && <TenuVaultConsent key={`${tenantId}/${initialPack ?? ""}`} tenantId={tenantId} plan={consent} initialPack={initialPack} active={connection.method === "tenuvaultApp"} upgrade={upgrade} onChanged={result => {
        setGraphError(undefined)
        setConnection(result.connection)
        onChanged(result.connection.clientId)
        toast("TenuVault app permissions verified.", "success")
      }} />}
      {tenantLicense?.organizationRenewalPending && <p role="status" className="basis-full text-sm text-gray-600">{ORGANIZATION_RENEWAL_NOTICE}</p>}
      <Dialog open={graphOpen} onOpenChange={value => { if (!busy) setGraphOpen(value) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign in with Start now</DialogTitle>
            <DialogDescription>Start now uses the permissions already granted to Microsoft Graph Command Line Tools. It supports read-only backups on this device.</DialogDescription>
          </DialogHeader>
          <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">{GRAPH_CLI_CONSENT_WARNING}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              if (busy) void bridge.auth.cancelSignIn()
              else setGraphOpen(false)
            }}>Cancel</Button>
            <Button disabled={busy} onClick={() => void startNow()}>{busy ? "Waiting for sign-in" : "Continue to Microsoft"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change app registration</DialogTitle>
            <DialogDescription>Sign in with your own app registration for this tenant. Your backups and schedules stay with the tenant.</DialogDescription>
          </DialogHeader>
          {(tenantLicense?.source === "tenant" || tenantLicense?.organizationRenewalPending) && (
            <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              Your organization license uses a shared app registration. Ask the license key holder to share the license using the new registration before your cached coverage expires.
            </p>
          )}
          <label className="block text-sm font-medium">
            Application (client) ID
            <input className="mt-1 w-full rounded-md border bg-background px-3 py-2" value={nextClientId} onChange={event => setNextClientId(event.target.value)} disabled={busy} />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              if (busy) void bridge.auth.cancelSignIn()
              else setOpen(false)
            }}>Cancel</Button>
            <Button disabled={busy || !isGuid(nextClientId.trim()) || nextClientId.trim().toLowerCase() === connection.clientId} onClick={() => void change()}>
              {busy ? "Waiting for sign-in" : "Sign in"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
