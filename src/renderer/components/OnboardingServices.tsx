import { Check, Fingerprint, Monitor, ShieldCheck } from "lucide-react"
import { Button } from "~/components/ui/button"
import type { PermissionChoice } from "../../shared/services/manifest"
import { OnboardingHeading, onboardingPrimary } from "./OnboardingCard"
import { BACKUP_SERVICES } from "../../shared/services/presentation"
import { cn } from "~/lib/utils"

const CARDS = {
  defender: { Icon: ShieldCheck, description: "Detection rules, attack simulations and security settings." },
  entra: { Icon: Fingerprint, description: "Conditional Access, identity and governance settings." },
  intune: { Icon: Monitor, description: "Device policies, apps, scripts and enrollment settings." },
}

export function OnboardingServices({ choice, onChange, onContinue }: { choice: PermissionChoice; onChange: (choice: PermissionChoice) => void; onContinue: () => void }) {
  const toggle = (id: keyof typeof CARDS) => {
    const next = { ...choice }
    if (next[id]) {
      delete next[id]
      if (id === "entra") delete next.conditionalAccess
    } else {
      next[id] = { access: "backup" }
      if (id === "entra") next.conditionalAccess = { access: "backup" }
    }
    onChange(next)
  }
  return <section className="space-y-6" aria-labelledby="setup-step--1">
    <OnboardingHeading id="setup-step--1" title="Which services do you want to connect?" subtitle="Choose the Microsoft services you want to back up." />
    <div className="grid gap-4 @3xl:grid-cols-3">
      {BACKUP_SERVICES.map(({ id, label }) => {
        const { Icon, description } = CARDS[id]
        const selected = Boolean(choice[id])
        return <button key={id} type="button" data-onboarding-service={id} aria-pressed={selected} aria-label={label} aria-describedby={`setup-service-${id}`}
          onClick={() => toggle(id)}
          className={cn("flex min-w-0 flex-col gap-4 rounded-2xl border bg-background p-5 text-left transition-colors hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary @3xl:min-h-44", selected ? "border-muted-foreground bg-secondary/60" : "border-border")}>
          <span className="flex items-center justify-between gap-2">
            <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-gray-700"><Icon className="size-5" aria-hidden="true" /></span>
            <span className={cn("flex size-5 items-center justify-center rounded-md border", selected ? "border-foreground bg-foreground text-background" : "border-gray-300")} aria-hidden="true">{selected && <Check className="size-3.5" />}</span>
          </span>
          <span>
            <span className="block text-base font-medium text-gray-900">{label}</span>
            <span id={`setup-service-${id}`} className="mt-1 block text-sm text-gray-600">{description}</span>
          </span>
        </button>
      })}
    </div>
    <div className="flex justify-center"><Button className={onboardingPrimary} disabled={!Object.keys(choice).length} onClick={onContinue}>Continue</Button></div>
  </section>
}
