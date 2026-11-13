import { useEffect, useRef, useState } from "react"
import { Sparkles, X } from "lucide-react"
import { Button } from "~/components/ui/button"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"
import { toast } from "../lib/toast"
import { hideTrialOffer, trialOfferEligible, trialOfferRefusal, useTrialOfferHidden } from "../lib/trial-offer"

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** What happens at the end. Starting the trial frees the Community claim, so another tenant may take it meanwhile. */
export const TRIAL_OFFER_END = "When the trial ends, this tenant continues on Community Free unless another tenant uses Community by then, in which case it needs a license; backups and settings are kept."

/**
 * A one-time offer on the dashboard to start the opt-in Pro trial for a Community tenant that
 * never had one. It only adds a choice: nothing in Community depends on it. "Not now" and a
 * refusal by the trial service hide it for that tenant for good.
 */
export function TrialOfferCard({ tenantId }: { tenantId: string }) {
  const id = tenantId.toLowerCase()
  const { status, refresh } = useLicense()
  const hidden = useTrialOfferHidden()
  // The tenant a start request is running for. One request at a time, for any tenant.
  const [startingFor, setStartingFor] = useState<string | null>(null)
  // Feedback belongs to the tenant it was for and is dropped once another tenant is selected.
  const [feedback, setFeedback] = useState<{ tenantId: string; kind: "error" | "refusal"; text: string } | null>(null)
  const running = useRef(false)
  const selected = useRef(id)
  selected.current = id
  useEffect(() => { setFeedback(current => current?.tenantId === id ? current : null) }, [id])

  const hide = (tenant: string) => hideTrialOffer(tenant, hidden).catch(error => {
    toast(`Could not save the choice for this tenant: ${message(error)}`, "error")
  })

  const start = async () => {
    if (running.current) return
    running.current = true
    const tenant = id
    setStartingFor(tenant)
    setFeedback(null)
    try {
      await bridge.license.startTenantTrial(tenant)
    } catch (failure) {
      // A refusal is saved with the tenant's license status; anything else can be retried.
      const after = await bridge.license.status().catch(() => null)
      const refused = trialOfferRefusal(after, tenant)
      if (refused) await hide(tenant)
      // A late answer for a tenant that is no longer selected changes nothing on screen.
      if (selected.current === tenant) setFeedback({ tenantId: tenant, kind: refused ? "refusal" : "error", text: refused ?? message(failure) })
    } finally {
      await refresh().catch(() => {})
      running.current = false
      setStartingFor(null)
    }
  }

  const notice = (text: string, role: "status" | "alert") => <div role={role} className="flex items-start gap-3 rounded-3xl border border-gray-200 bg-white px-5 py-4 text-sm text-gray-700">
    <span className="min-w-0 flex-1">{text}</span>
    <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-full" onClick={() => setFeedback(null)}><X aria-hidden="true" /><span className="sr-only">Close</span></Button>
  </div>
  if (feedback?.tenantId === id && feedback.kind === "refusal") return notice(feedback.text, "status")
  if (!hidden || !trialOfferEligible(status, id, hidden)) {
    // A failed start that was not a refusal can leave the offer ineligible for now, for example when
    // the trial service could not be reached. The error stays visible instead of vanishing with the card.
    if (feedback?.tenantId === id && feedback.kind === "error") return notice(`${feedback.text} You can try again later on the License page.`, "alert")
    return null
  }
  const days = status?.tenantTrialPolicy?.days ?? 14
  const error = feedback?.tenantId === id && feedback.kind === "error" ? feedback.text : ""
  return <section aria-labelledby="trial-offer-title" className="overflow-hidden rounded-3xl border border-gray-200 bg-white">
    <div className="tv-trial-header flex flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-blue-100 bg-white text-blue-700" aria-hidden="true"><Sparkles className="size-5" /></span>
        <div className="min-w-0">
          {/* A tenant whose trial already runs on another installation joins it at its end date, so the length is a maximum. */}
          <h2 id="trial-offer-title" className="text-xl font-medium text-gray-900">Try Pro free for up to {days} days on this tenant</h2>
          <p className="mt-1 text-sm text-gray-600">
            Pro adds daily backups, full restore, replace in place, drift revert, Azure storage, the audit log and white-label PDF reports.
            Nothing in Community changes. {TRIAL_OFFER_END}
          </p>
          {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" className="bg-blue-600 text-white hover:bg-blue-700" disabled={startingFor !== null} onClick={() => void start()}>{startingFor === id ? "Starting trial..." : "Start free trial"}</Button>
        <Button type="button" variant="outline" disabled={startingFor !== null} onClick={() => void hide(id)}>Not now</Button>
      </div>
    </div>
  </section>
}
