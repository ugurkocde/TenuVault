import { Sparkles } from "lucide-react"
import { cn } from "~/lib/utils"
import { FEATURE_PLAN, planLabel, upgradeMessage, type Feature } from "../../shared/plans"
import { PlanPromptButton } from "./PlanPromptButton"

/**
 * Explains that the tenant's plan does not include a feature, with the trial, the checkout or
 * the plans.
 * message replaces the standard text when one note covers several features.
 */
export function UpgradeNote({ feature, message, className }: { feature: Feature; message?: string; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-3xl bg-blue-50/60 px-5 py-4 text-sm text-gray-700", className)}>
      <Sparkles className="h-4 w-4 flex-shrink-0 text-coral-600" aria-hidden="true" />
      <p className="min-w-0 flex-1">{message ?? upgradeMessage(feature)}</p>
      <PlanPromptButton plan={FEATURE_PLAN[feature]} source={`note-${feature.toLowerCase()}`} variant="outline" size="sm" />
    </div>
  )
}

/**
 * Marks an option that needs a higher plan, such as "Pro". A quiet neutral chip, like the plan chip next to
 * License in the sidebar, so it informs without competing with coral actions and the selected entry.
 */
export function PlanBadge({ feature, className }: { feature: Feature; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium leading-4 text-gray-700", className)}>
      {planLabel(FEATURE_PLAN[feature])}
    </span>
  )
}
