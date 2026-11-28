import { NoticeCard } from "./NoticeCard"
import { cn } from "~/lib/utils"
import { FEATURE_PLAN, planLabel, upgradeMessage, type Feature } from "../../shared/plans"
import { PlanPromptButton } from "./PlanPromptButton"

/**
 * Explains that the tenant's plan does not include a feature, with the trial, the checkout or
 * the plans.
 * message replaces the standard text when one note covers several features. tenantId names the tenant the
 * prompt acts on when it is not the selected tenant, such as a restore destination.
 */
export function UpgradeNote({ feature, message, className, tenantId }: { feature: Feature; message?: string; className?: string; tenantId?: string | null }) {
  return <NoticeCard className={className} summary={message ?? upgradeMessage(feature)}
    action={<PlanPromptButton plan={FEATURE_PLAN[feature]} source={`note-${feature.toLowerCase()}`} variant="outline" size="sm" tenantId={tenantId} />} />
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
