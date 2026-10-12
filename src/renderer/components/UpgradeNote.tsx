import { ExternalLink, Sparkles } from "lucide-react"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { FEATURE_PLAN, planLabel, upgradeMessage, type Feature } from "../../shared/plans"
import { bridge } from "../lib/bridge"

/**
 * Explains that the tenant's plan does not include a feature, with a way to see the plans.
 * message replaces the standard text when one note covers several features.
 */
export function UpgradeNote({ feature, message, className }: { feature: Feature; message?: string; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-3xl bg-blue-50/60 px-5 py-4 text-sm text-gray-700", className)}>
      <Sparkles className="h-4 w-4 flex-shrink-0 text-coral-600" aria-hidden="true" />
      <p className="min-w-0 flex-1">{message ?? upgradeMessage(feature)}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => void bridge.license.open("buy", { source: `note-${feature.toLowerCase()}` })}>
        <ExternalLink className="mr-2 h-4 w-4" />
        See plans
      </Button>
    </div>
  )
}

/** Marks an option that needs a higher plan, such as "Pro". */
export function PlanBadge({ feature, className }: { feature: Feature; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full bg-coral-100 px-2 py-0.5 text-xs font-medium text-coral-700", className)}>
      {planLabel(FEATURE_PLAN[feature])}
    </span>
  )
}
