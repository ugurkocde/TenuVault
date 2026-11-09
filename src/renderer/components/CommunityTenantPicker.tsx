import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AlertTriangle } from "lucide-react"
import { useTenants } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { bridge } from "../lib/bridge"
import { openCommunityTenantPicker, subscribeCommunityTenantPicker } from "../lib/community-choice"
import { closePlanDialog } from "../lib/plan-dialog"
import { useLicense } from "../lib/license"

export function CommunityTenantChoiceButton() {
  const { status } = useLicense()
  if ((status?.communityChoicePendingTenantIds?.length ?? 0) <= 1) return null
  return <Button type="button" size="sm" onClick={openCommunityTenantPicker}>Choose tenant</Button>
}

export function CommunityChoiceBanner() {
  const { status } = useLicense()
  if ((status?.communityChoicePendingTenantIds?.length ?? 0) <= 1) return null
  return <div className="px-6 pt-5 lg:px-8">
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-3xl bg-amber-50 p-2 text-sm font-medium text-amber-900">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-card text-amber-700" aria-hidden="true"><AlertTriangle className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1">Choose which tenant continues on Community. Backups are paused until you choose.</span>
      <CommunityTenantChoiceButton />
    </div>
  </div>
}

export function CommunityTenantPicker() {
  const { status, refresh } = useLicense()
  const tenants = useTenants()
  const navigate = useNavigate()
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")
  const choices = status?.communityChoiceTenantIds ?? []
  const pending = status?.communityChoicePendingTenantIds ?? choices
  useEffect(() => subscribeCommunityTenantPicker(() => { setError(""); setDismissed(false) }), [])
  const run = async (id: string, choose: boolean) => {
    setBusy(id)
    setError("")
    try {
      if (choose) { await bridge.license.chooseCommunity(id); closePlanDialog() }
      else await bridge.license.retry(id)
      await refresh()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(null) }
  }
  return <Dialog open={pending.length > 1 && !dismissed} onOpenChange={(open) => { if (!open) setDismissed(true) }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Choose your Community tenant</DialogTitle><DialogDescription>One tenant continues on Community. This choice is final. Backups of the other tenants are kept. Add a license to use them again. You can decide later or add a license instead.</DialogDescription></DialogHeader>
      {error && <p role="alert">{error}</p>}
      {pending.map((id) => !choices.includes(id) ? <div key={id} className="flex items-center gap-3 rounded-2xl bg-gray-50 p-4 text-sm">
        <div className="min-w-0 flex-1"><strong>{tenants.find((tenant) => tenant.credentials?.tenantId?.toLowerCase() === id)?.name ?? id}</strong><span className="block text-gray-600">Coverage could not be checked. Retry to check this tenant before choosing.</span></div>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void run(id, false)}>{busy === id ? "Retrying..." : "Retry"}</Button>
      </div> : <Button key={id} disabled={busy !== null} variant="outline" onClick={() => void run(id, true)}>{tenants.find((tenant) => tenant.credentials?.tenantId?.toLowerCase() === id)?.name ?? id}</Button>)}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => setDismissed(true)}>Decide later</Button>
        <Button type="button" onClick={() => { setDismissed(true); closePlanDialog(); navigate("/license") }}>Add a license instead</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
