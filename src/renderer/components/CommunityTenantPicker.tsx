import { useState } from "react"
import { useTenants } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { bridge } from "../lib/bridge"
import { closePlanDialog } from "../lib/plan-dialog"
import { useLicense } from "../lib/license"

export function CommunityTenantPicker() {
  const { status, refresh } = useLicense()
  const tenants = useTenants()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const choices = status?.communityChoiceTenantIds ?? []
  const pending = status?.communityChoicePendingTenantIds ?? choices
  return <Dialog open={pending.length > 1}>
    <DialogContent hideClose className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Choose your Community tenant</DialogTitle><DialogDescription>One tenant continues on Community. Backups of the other tenants are kept. Add a license to use them again.</DialogDescription></DialogHeader>
      {error && <p role="alert">{error}</p>}
      {pending.map((id) => !choices.includes(id) ? <p key={id} className="rounded-2xl bg-gray-50 p-4 text-sm"><strong>{tenants.find((tenant) => tenant.credentials?.tenantId?.toLowerCase() === id)?.name ?? id}</strong><span className="block text-gray-600">Coverage could not be checked. Retry this tenant on the License page. It cannot be chosen yet.</span></p> : <Button key={id} disabled={busy} variant="outline" onClick={async () => {
        setBusy(true)
        setError("")
        try { await bridge.license.chooseCommunity(id); closePlanDialog(); await refresh() }
        catch (error) { setError(error instanceof Error ? error.message : String(error)) }
        finally { setBusy(false) }
      }}>{tenants.find((tenant) => tenant.credentials?.tenantId?.toLowerCase() === id)?.name ?? id}</Button>)}
    </DialogContent>
  </Dialog>
}
