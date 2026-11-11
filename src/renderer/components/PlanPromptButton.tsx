import { useRef } from "react"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { TenantTrialOptions } from "./TenantTrial"
import { ExternalLink, Sparkles } from "lucide-react"
import { Link, useInRouterContext } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"
import type { TenantLicenseStatus } from "../../shared/ipc"
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
 * license, Buy Pro or Buy MSP once the trial was used, otherwise See plans. A trial this
 * installation ended early is offered again next to Buy Pro while it can be resumed. onLeave closes a
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
  const prompted = status && !status.hasKey && plan === "pro" ? status : null
  const here = (t: TenantLicenseStatus) => Boolean(tenantId) && t.tenantId === tenantId && t.signedIn && !t.entitled && !t.activated
  // A new trial needs the trial switch. A trial this installation ended early is offered
  // again without it: an installation with a license for another tenant never learns the
  // switch, and the service refuses the resume itself while trials are off.
  const eligible = prompted?.tenants.find(t => here(t) && (t.trialCanResume || (prompted.tenantTrialsEnabled && !(t.trialRefusalPermanent ?? Boolean(t.trialRefusal)))))
  // A resume the service refuses for good ends the offer. The prompt keeps that tenant's
  // trial options mounted, so the reason stays on screen next to Buy Pro.
  const resumeOffered = useRef<string | undefined>(undefined)
  if (eligible?.trialCanResume) resumeOffered.current = eligible.tenantId
  const shown = eligible ?? (resumeOffered.current ? prompted?.tenants.find(t => t.tenantId === resumeOffered.current && here(t)) : undefined)
  const requested = planPromptAction(status, plan)
  // With tenant trials, or next to a resume offer, the purchase is the other choice, not the emailed trial.
  const action = (status?.tenantTrialsEnabled || shown) && requested === "trial" ? "checkout" : requested
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
  return shown ? <span className="inline-flex flex-wrap items-center gap-3">
    {purchase}
    <TenantTrialOptions tenantId={shown.tenantId} compact variant={variant} size={size} onStarted={onLeave} />
  </span> : purchase
}
