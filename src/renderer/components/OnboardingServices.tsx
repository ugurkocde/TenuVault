import { Check, Fingerprint, Monitor, ShieldCheck } from "lucide-react"
import { Button } from "~/components/ui/button"
import type { PermissionChoice } from "../../shared/services/manifest"
import { choiceLabel } from "../../shared/services/onboarding"
import { BACKUP_SERVICES } from "../../shared/services/presentation"
import { cn } from "~/lib/utils"

const CARDS = {
  defender: { Icon: ShieldCheck, description: "Detection rules, attack simulations, identity and security posture settings." },
  entra: { Icon: Fingerprint, description: "Identity and governance settings, including Conditional Access." },
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
  return <section className="space-y-4" aria-labelledby="setup-step--1">
    <h2 id="setup-step--1" tabIndex={-1} className="text-2xl font-medium tracking-tight text-gray-900 outline-none">Which services do you want to connect?</h2>
    <div className="grid gap-3 @3xl:grid-cols-3">
      {BACKUP_SERVICES.map(({ id, label }) => {
        const { Icon, description } = CARDS[id]
        const selected = Boolean(choice[id])
        return <button key={id} type="button" data-onboarding-service={id} aria-pressed={selected} aria-label={label} aria-describedby={`setup-service-${id}`}
          onClick={() => toggle(id)}
          className={cn("flex min-w-0 flex-col gap-3 rounded-2xl border bg-background p-4 text-left transition-colors hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary @3xl:min-h-40", selected ? "border-muted-foreground bg-secondary/60" : "border-border")}>
          <span className="flex items-center justify-between gap-2">
            <span className="flex size-9 items-center justify-center rounded-lg bg-secondary text-gray-700"><Icon className="size-5" aria-hidden="true" /></span>
            <span className={cn("flex size-5 items-center justify-center rounded-md border", selected ? "border-foreground bg-foreground text-background" : "border-gray-300")} aria-hidden="true">{selected && <Check className="size-3.5" />}</span>
          </span>
          <span>
            <span className="block font-medium text-gray-900">{label}</span>
            <span id={`setup-service-${id}`} className="mt-1 block text-sm text-gray-600">{description}</span>
          </span>
        </button>
      })}
    </div>
    <div className="flex justify-end"><Button className="bg-blue-600 hover:bg-blue-700" disabled={!Object.keys(choice).length} onClick={onContinue}>Continue{Object.keys(choice).length > 0 && ` with ${choiceLabel(choice)}`}</Button></div>
  </section>
}
