import { useState, type ComponentProps, type ReactNode } from "react"
import { ExternalLink, Lock, Sparkles } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { cn } from "~/lib/utils"
import { allows, FEATURE_PLAN, featureName, planLabel, upgradeMessage, type Feature, type Plan } from "../../shared/plans"
import { bridge } from "../lib/bridge"
import { PlanBadge } from "./UpgradeNote"

/**
 * How the app shows features the tenant's plan does not include (the rule for every screen):
 *
 * 1. An option inside a screen Community uses stays visible with its plan badge. It is not
 *    clickable for the action: a GatedButton explains the plan instead of failing.
 * 2. A whole paid screen shows a LockedPreview: what it does and what it would show, never a
 *    blurred result, because paid results are not computed for plans that do not include them.
 * 3. Records created on a paid plan stay readable after a downgrade; only new ones are locked.
 *
 * The main process enforces the same limits (plan-gates.ts, features/route.ts); these
 * components only explain them.
 */
export function canUse(plan: Plan | null, feature: Feature): boolean {
  return plan !== null && allows(plan, feature)
}

/** A short dialog that says which plan includes a feature, with a link to the plans. */
export function UpgradeDialog({ feature, message, open, onOpenChange }: { feature: Feature; message?: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="pr-10">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-coral-600" aria-hidden="true" />
            Included in {FEATURE_PLAN[feature] === "msp" ? "TenuVault MSP" : "TenuVault Pro and MSP"}
          </DialogTitle>
          <DialogDescription>{upgradeMessage(feature)}</DialogDescription>
          {message && message !== upgradeMessage(feature) && <p className="text-sm text-muted-foreground">{message}</p>}
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" onClick={() => void bridge.license.open("buy", { source: `plan-dialog-${feature.toLowerCase()}` })}>
            <ExternalLink className="h-4 w-4" />
            See plans
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type GatedButtonProps = ComponentProps<typeof Button> & { feature: Feature; plan: Plan | null }

/**
 * A button for a paid action. When the plan includes the feature it is an ordinary button.
 * Otherwise it stays focusable and visible with its plan badge, is marked aria-disabled, and
 * a click explains the plan instead of running the action. While the plan is loading it is
 * disabled.
 */
export function GatedButton({ feature, plan, onClick, children, className, disabled, ...props }: GatedButtonProps) {
  const [explaining, setExplaining] = useState(false)
  if (canUse(plan, feature)) {
    return (
      <Button {...props} className={className} disabled={disabled} onClick={onClick}>
        {children}
      </Button>
    )
  }
  return (
    <>
      <Button
        {...props}
        type="button"
        aria-disabled="true"
        disabled={plan === null || disabled}
        title={upgradeMessage(feature)}
        className={cn("opacity-70", className)}
        onClick={() => setExplaining(true)}
      >
        {children}
        <PlanBadge feature={feature} className="ml-1" />
      </Button>
      <UpgradeDialog feature={feature} open={explaining} onOpenChange={setExplaining} />
    </>
  )
}

/**
 * The preview of a paid screen: what it does, what it would show for this tenant and which
 * plan includes it. Shown instead of results; stored records from an earlier plan may follow it.
 */
export function LockedPreview({ feature, summary, points, className, children }: { feature: Feature; summary: string; points: string[]; className?: string; children?: ReactNode }) {
  return (
    <section aria-label={`${featureName(feature)} preview`} className={cn("rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-coral-100 text-coral-700" aria-hidden="true">
          <Lock className="h-4 w-4" />
        </span>
        <h2 className="text-lg font-medium text-gray-900">{featureName(feature)}</h2>
        <PlanBadge feature={feature} />
      </div>
      <p className="mt-4 max-w-3xl text-sm text-gray-600">{summary}</p>
      <ul className="mt-4 max-w-3xl list-disc space-y-1.5 pl-5 text-sm text-gray-600">
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {children}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => void bridge.license.open("buy", { source: `locked-${feature.toLowerCase()}` })}>
          <ExternalLink className="h-4 w-4" />
          See plans
        </Button>
        <span className="text-sm text-gray-500">Included in TenuVault {planLabel(FEATURE_PLAN[feature]) === "MSP" ? "MSP" : "Pro and MSP"}.</span>
      </div>
    </section>
  )
}
