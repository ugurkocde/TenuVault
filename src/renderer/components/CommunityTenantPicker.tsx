import { useState } from "react"
import { useTenants } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"

export function CommunityTenantPicker() {
  const { status, refresh } = useLicense()
  const tenants = useTenants()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const choices = status?.communityChoiceTenantIds ?? []
  return <Dialog open={choices.length > 1}>
    <DialogContent hideClose>
      <DialogHeader><DialogTitle>Choose your Community tenant</DialogTitle><DialogDescription>One tenant continues on Community. Backups of the other tenants are kept. Add a license to use them again.</DialogDescription></DialogHeader>
      {error && <p role="alert">{error}</p>}
      {choices.map((id) => <Button key={id} disabled={busy} variant="outline" onClick={async () => {
        setBusy(true)
        setError("")
        try { await bridge.license.chooseCommunity(id); await refresh() }
        catch (error) { setError(error instanceof Error ? error.message : String(error)) }
        finally { setBusy(false) }
      }}>{tenants.find((tenant) => tenant.credentials?.tenantId?.toLowerCase() === id)?.name ?? id}</Button>)}
    </DialogContent>
  </Dialog>
}
