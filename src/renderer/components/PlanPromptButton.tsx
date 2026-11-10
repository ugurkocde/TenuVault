import { useSelectedTenant } from "~/contexts/TenantContext"
import { TenantTrialOptions } from "./TenantTrial"
import { ExternalLink, Sparkles } from "lucide-react"
import { Link, useInRouterContext } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"
import { openCheckout, planPromptAction } from "../lib/purchase"

// The license status, or null outside a LicenseProvider. useLicense reads the context once
// either way, so catching its error keeps the hook order.
function useStatusIfProvided() {
  try {
    return useLicense().status
  } catch {
    return null
  }
}

function useTenantIfProvided() {
  try { return useSelectedTenant().selectedTenant?.credentials?.tenantId?.toLowerCase() } catch { return undefined }
}

/**
 * The main action of a plan prompt (planPromptAction): a free trial without a
 * license, Buy Pro or Buy MSP once the trial was used, otherwise See plans. onLeave closes a
 * dialog before the trial opens the License page. Outside a router or license provider (a
 * screen rendered alone) it falls back to See plans.
 */
export function PlanPromptButton({
  plan,
  source,
  onLeave,
  variant,
  size,
  tenantId: contextTenantId,
}: {
  plan: "pro" | "msp"
  source: string
  tenantId?: string | null
  onLeave?: () => void
  variant?: "default" | "outline"
  size?: "default" | "sm"
}) {
  const status = useStatusIfProvided()
  const inRouter = useInRouterContext()
  const selectedTenantId = useTenantIfProvided()
  const tenantId = contextTenantId === undefined ? selectedTenantId : contextTenantId?.toLowerCase()
  const tenant = status?.tenants.find(t => t.tenantId === tenantId)
  const eligible = status?.tenantTrialsEnabled && !status.hasKey && plan === "pro" ? status.tenants.find(t =>
    (tenantId && t.tenantId === tenantId) && t.signedIn && !t.entitled && !t.activated && !(t.trialRefusalPermanent ?? Boolean(t.trialRefusal)),
  ) : undefined
  const requested = planPromptAction(status, plan)
  const action = status?.tenantTrialsEnabled && requested === "trial" ? "checkout" : requested
  if (action === "trial" && inRouter) {
    // A link: the trial form is on the License page.
    return (
      <Button asChild variant={variant} size={size}>
        <Link to="/license" state={{ startTrial: true }} onClick={() => onLeave?.()}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {status?.tenantTrialsEnabled ? "Try Pro free" : "Start 30 day free trial"}
        </Link>
      </Button>
    )
  }
  const purchase = action === "checkout" ? (
    <Button type="button" variant={variant} size={size} onClick={() => void openCheckout(source, { plan })}>
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
      {plan === "msp" ? "Buy MSP" : "Buy Pro"}
    </Button>
  ) : (
    <Button type="button" variant={variant} size={size} onClick={() => void bridge.license.open("buy", { source })}>
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
      See plans
    </Button>
  )
  return eligible || tenant?.trialRefusal ? <span className="inline-flex flex-wrap items-center gap-3">
    {purchase}
    {eligible ? <TenantTrialOptions tenantId={eligible.tenantId} compact variant={variant} size={size} onStarted={onLeave} /> : <span role="status" className="text-sm text-gray-600">{tenant?.trialRefusal}</span>}
  </span> : purchase
}
