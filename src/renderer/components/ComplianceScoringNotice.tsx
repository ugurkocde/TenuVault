import { useEffect, useState } from "react"
import { X } from "lucide-react"

export const COMPLIANCE_SCORING_NOTICE_KEY = "tenuvault-compliance-scoring-v2-dismissed"
export const COMPLIANCE_SCORING_NOTICE = "Compliance scoring changed in this version. Scores are now per capability and only count assigned policies, so they are not comparable with earlier history."

/**
 * One-time notice, stored like the renderer's appearance preference. It counts as seen the
 * first time it is shown, so it stays on the page where it appeared but does not repeat on
 * every other framework page or the scores tab.
 */
export function ComplianceScoringNotice({ changed }: { changed: boolean }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(COMPLIANCE_SCORING_NOTICE_KEY) === "true")
  const shown = changed && !dismissed
  useEffect(() => {
    if (shown) localStorage.setItem(COMPLIANCE_SCORING_NOTICE_KEY, "true")
  }, [shown])
  if (!shown) return null
  return <div role="status" className="flex items-start justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
    <p>{COMPLIANCE_SCORING_NOTICE}</p>
    <button type="button" aria-label="Dismiss compliance scoring notice" className="-mr-1 -mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full" onClick={() => {
      localStorage.setItem(COMPLIANCE_SCORING_NOTICE_KEY, "true")
      setDismissed(true)
    }}><X className="size-4" aria-hidden="true" /></button>
  </div>
}
