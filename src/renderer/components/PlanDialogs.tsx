import { useSyncExternalStore } from "react"
import { useNavigate } from "react-router-dom"
import { useTenants } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { CommunityLimitError } from "../../shared/plan-errors"
import { bridge } from "../lib/bridge"
import { isUnlicensed, useLicense } from "../lib/license"
import { closePlanDialog, planDialogError, subscribePlanDialog } from "../lib/plan-dialog"
import { UpgradeDialog } from "./PlanGate"

/** One plan dialog for errors from queries, mutations and direct requests. */
export function PlanDialogs() {
  const error = useSyncExternalStore(subscribePlanDialog, planDialogError)
  const tenants = useTenants()
  const { status } = useLicense()
  const navigate = useNavigate()
  if (!error) return null
  if (!(error instanceof CommunityLimitError)) {
    return error.upgrade ? <UpgradeDialog feature={error.upgrade} message={error.message} open onOpenChange={closePlanDialog} /> : null
  }
  const owner = tenants.find((tenant) => tenant.credentials?.tenantId?.toLowerCase() === error.tenantId.toLowerCase())?.name || error.tenantId
  return (
    <Dialog open onOpenChange={closePlanDialog}>
      <DialogContent>
        <DialogHeader className="pr-10">
          <DialogTitle>Community covers one tenant</DialogTitle>
          <DialogDescription>
            The tenant was not added. Community covers one tenant, and it is used for {owner}. Pro covers two tenants, for example production and test. New MSP subscriptions include five.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={closePlanDialog}>Not now</Button>
          <Button type="button" variant="outline" onClick={() => { closePlanDialog(); void navigate("/license") }}>Add a license key</Button>
          {/* The License page offers the trial only without a key or organization license. */}
          {status && isUnlicensed(status) ? (
            <Button type="button" onClick={() => { closePlanDialog(); void navigate("/license", { state: { startTrial: true } }) }}>Start 30 day free trial</Button>
          ) : (
            <Button type="button" onClick={() => void bridge.license.open("buy", { source: "second-tenant" })}>See plans</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
