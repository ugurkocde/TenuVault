import { useEffect, useRef, useState } from "react"
import { Sparkles, X } from "lucide-react"
import { Button } from "~/components/ui/button"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"
import { toast } from "../lib/toast"
import { trialOfferEligible, trialOfferRefusal } from "../lib/trial-offer"

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * A one-time offer on the dashboard to start the opt-in Pro trial for a Community tenant that
 * never had one. It only adds a choice: nothing in Community depends on it. "Not now" and a
 * refusal by the trial service hide it for that tenant for good.
 */
export function TrialOfferCard({ tenantId }: { tenantId: string }) {
  const id = tenantId.toLowerCase()
  const { status, refresh } = useLicense()
  const [hidden, setHidden] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  // The trial service's refusal, shown once in place of the card until the admin closes it or leaves.
  const [refusal, setRefusal] = useState<{ tenantId: string; text: string } | null>(null)
  const running = useRef(false)

  useEffect(() => {
    let active = true
    void bridge.preferences.get().then(
      preferences => { if (active) setHidden(preferences.trialOfferHiddenTenantIds ?? []) },
      // Without the saved dismissals the card stays hidden rather than coming back.
      () => {},
    )
    return () => { active = false }
  }, [])
  useEffect(() => { setError("") }, [id])

  const hide = async (tenant: string) => {
    setHidden(current => current && !current.includes(tenant) ? [...current, tenant] : current)
    try {
      const saved = (await bridge.preferences.get()).trialOfferHiddenTenantIds ?? []
      if (!saved.includes(tenant)) await bridge.preferences.set({ trialOfferHiddenTenantIds: [...saved, tenant] })
    } catch (error) {
      toast(`Could not save the choice for this tenant: ${message(error)}`, "error")
    }
  }

  const start = async () => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError("")
    try {
      await bridge.license.startTenantTrial(id)
    } catch (failure) {
      // A refusal is saved with the tenant's license status; anything else can be retried.
      const after = await bridge.license.status().catch(() => null)
      const refused = trialOfferRefusal(after, id)
      if (refused) {
        setRefusal({ tenantId: id, text: refused })
        await hide(id)
      } else {
        setError(message(failure))
      }
    } finally {
      await refresh().catch(() => {})
      running.current = false
      setBusy(false)
    }
  }

  if (refusal?.tenantId === id) {
    return <div role="status" className="flex items-start gap-3 rounded-3xl border border-gray-200 bg-white px-5 py-4 text-sm text-gray-700">
      <span className="min-w-0 flex-1">{refusal.text}</span>
      <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-full" onClick={() => setRefusal(null)}><X aria-hidden="true" /><span className="sr-only">Close</span></Button>
    </div>
  }
  if (!hidden || !trialOfferEligible(status, id, hidden)) return null
  const days = status?.tenantTrialPolicy?.days ?? 14
  return <section aria-labelledby="trial-offer-title" className="overflow-hidden rounded-3xl border border-gray-200 bg-white">
    <div className="tv-trial-header flex flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-blue-100 bg-white text-blue-700" aria-hidden="true"><Sparkles className="size-5" /></span>
        <div className="min-w-0">
          <h2 id="trial-offer-title" className="text-xl font-medium text-gray-900">Try Pro free for {days} days on this tenant</h2>
          <p className="mt-1 text-sm text-gray-600">
            Pro adds daily backups, full restore, replace in place, drift revert, Azure storage, the audit log and white-label PDF reports.
            Nothing in Community changes. After {days} days this tenant goes back to Community unless you add a license.
          </p>
          {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" className="bg-blue-600 text-white hover:bg-blue-700" disabled={busy} onClick={() => void start()}>{busy ? "Starting trial..." : "Start free trial"}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void hide(id)}>Not now</Button>
      </div>
    </div>
  </section>
}
