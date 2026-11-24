import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { SIGN_IN_METHODS, type TenantConnection } from "../../shared/tenant-connection"
import { isGuid } from "../../shared/security"
import { bridge } from "../lib/bridge"
import { toast } from "../lib/toast"

export function TenantConnectionSettings({ tenantId, clientId, onChanged }: {
  tenantId: string
  clientId: string
  onChanged: (clientId: string) => void
}) {
  const [connection, setConnection] = useState<TenantConnection | null>(null)
  const [open, setOpen] = useState(false)
  const [nextClientId, setNextClientId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let current = true
    void bridge.auth.connection(tenantId).then(value => { if (current) setConnection(value) }).catch(() => undefined)
    return () => { current = false }
  }, [tenantId, clientId])

  const change = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await bridge.auth.switchConnection(tenantId, { method: "ownApp", clientId: nextClientId.trim() })
      setConnection(result.connection)
      onChanged(result.connection.clientId)
      setOpen(false)
      toast(result.missing.length
        ? "Sign-in method updated. Review missing permissions under Services and permissions."
        : "Sign-in method updated.", "success")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The sign-in method could not be changed.")
    } finally {
      setBusy(false)
    }
  }

  if (connection?.origin !== "wizard") return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <p className="text-xs text-gray-500">Sign-in method: {SIGN_IN_METHODS[connection.method]}</p>
      <Button variant="outline" size="sm" onClick={() => { setNextClientId(""); setError(undefined); setOpen(true) }}>
        Change sign-in method
      </Button>
      <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change sign-in method</DialogTitle>
            <DialogDescription>Sign in with your own app registration for this tenant. Your backups, schedules and license stay with the tenant.</DialogDescription>
          </DialogHeader>
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
