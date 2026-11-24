import { TenuVaultConsent } from "./TenuVaultConsent"
import type { PackConsentPlan } from "../../shared/pack-consent"
import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { ORGANIZATION_RENEWAL_NOTICE, SIGN_IN_METHODS, type TenantConnection } from "../../shared/tenant-connection"
import { isGuid } from "../../shared/security"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"
import { toast } from "../lib/toast"

export function TenantConnectionSettings({ tenantId, clientId, onChanged }: {
  tenantId: string
  clientId: string
  onChanged: (clientId: string) => void
}) {
  const [connection, setConnection] = useState<TenantConnection | null>(null)
  const [consent, setConsent] = useState<PackConsentPlan | null>(null)
  const { status } = useLicense()
  const [open, setOpen] = useState(false)
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
        const plan = await bridge.auth.packConsentPlan(tenantId)
        if (current) setConsent(plan)
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

  if (connection?.origin !== "wizard") return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <p className="text-xs text-gray-500">Sign-in method: {SIGN_IN_METHODS[connection.method]}</p>
      <Button variant="outline" size="sm" onClick={() => { setNextClientId(""); setError(undefined); setOpen(true) }}>
        Change app registration
      </Button>
      {consent && <TenuVaultConsent key={tenantId} tenantId={tenantId} plan={consent} active={connection.method === "tenuvaultApp"} onChanged={result => {
        setConnection(result.connection)
        onChanged(result.connection.clientId)
        toast("TenuVault app permissions verified.", "success")
      }} />}
      {tenantLicense?.organizationRenewalPending && <p role="status" className="basis-full text-sm text-gray-600">{ORGANIZATION_RENEWAL_NOTICE}</p>}
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
