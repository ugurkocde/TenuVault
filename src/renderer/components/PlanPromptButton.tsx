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

/**
 * The main action of a plan prompt (planPromptAction): Start 30 day free trial without a
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
}: {
  plan: "pro" | "msp"
  source: string
  onLeave?: () => void
  variant?: "default" | "outline"
  size?: "default" | "sm"
}) {
  const status = useStatusIfProvided()
  const inRouter = useInRouterContext()
  const action = planPromptAction(status, plan)
  if (status?.tenantTrialsEnabled && !status.hasKey && !status.trial && status.tenants.some(t => t.signedIn && !t.entitled)) return <TenantTrialOptions onStarted={onLeave} />
  if ((action === "trial" || status?.tenantTrialsEnabled && !status.hasKey && !status.trial) && inRouter) {
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
  if (action === "checkout") {
    return (
      <Button type="button" variant={variant} size={size} onClick={() => void openCheckout(source, { plan })}>
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
        {plan === "msp" ? "Buy MSP" : "Buy Pro"}
      </Button>
    )
  }
  return (
    <Button type="button" variant={variant} size={size} onClick={() => void bridge.license.open("buy", { source })}>
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
      See plans
    </Button>
  )
}
