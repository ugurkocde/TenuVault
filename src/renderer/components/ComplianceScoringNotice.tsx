import { useState } from "react"
import { X } from "lucide-react"

export const COMPLIANCE_SCORING_NOTICE_KEY = "tenuvault-compliance-scoring-v2-dismissed"
export const COMPLIANCE_SCORING_NOTICE = "Compliance scoring changed in this version. Scores are now per capability and only count assigned policies, so they are not comparable with earlier history."

/** Machine preference, stored like the renderer's appearance preference. */
export function ComplianceScoringNotice({ changed }: { changed: boolean }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(COMPLIANCE_SCORING_NOTICE_KEY) === "true")
  if (!changed || dismissed) return null
  return <div role="status" className="flex items-start justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
    <p>{COMPLIANCE_SCORING_NOTICE}</p>
    <button type="button" aria-label="Dismiss compliance scoring notice" onClick={() => {
      localStorage.setItem(COMPLIANCE_SCORING_NOTICE_KEY, "true")
      setDismissed(true)
    }}><X className="size-4" aria-hidden="true" /></button>
  </div>
}
