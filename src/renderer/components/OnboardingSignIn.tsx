import { Cloud, KeyRound, Zap } from "lucide-react"
import { cn } from "~/lib/utils"
import { OnboardingHeading, onboardingLink } from "./OnboardingCard"
import { SIGN_IN_METHODS, type SignInMethod } from "../../shared/tenant-connection"
import { graphPermissions, type PermissionChoice } from "../../shared/services/manifest"
import { tenantPermissionPacks } from "../../shared/services/permission-packs"

const CARDS = [
  { id: "graphCli", Icon: Zap, copy: "Back up with the access you already have.", creates: "Creates no app registration" },
  { id: "tenuvaultApp", Icon: Cloud, copy: "An admin approves access for backup.", creates: "Adds TenuVault to your tenant" },
  { id: "ownApp", Icon: KeyRound, copy: "Use an app your organization manages.", creates: "Uses or creates an app registration" },
] as const

export type MethodAvailability = Record<"graphCli" | "tenuvaultApp", boolean | null>

export function OnboardingSignIn({ available, choice, onChoose }: { available: MethodAvailability; choice: PermissionChoice; onChoose: (method: SignInMethod) => void }) {
  const permissions = [
    { label: SIGN_IN_METHODS.ownApp, names: graphPermissions(choice, "delegated") },
    {
      label: SIGN_IN_METHODS.tenuvaultApp,
      names: [...new Set(tenantPermissionPacks(choice, { azure: false, audit: false }).flatMap(pack => pack.scopes))],
    },
  ]
  return <section className="space-y-6" aria-labelledby="setup-step--2">
    <OnboardingHeading id="setup-step--2" title="How do you want to connect?" subtitle="Choose how TenuVault gets access to your tenant." />
    <div className="grid gap-4 @3xl:grid-cols-3">
      {CARDS.map(({ id, Icon, copy, creates }) => {
        const title = SIGN_IN_METHODS[id]
        const enabled = id === "ownApp" || available[id] === true
        const pending = id !== "ownApp" && available[id] === null
        return <button key={id} data-sign-in-method={id} type="button" aria-label={`Choose ${title}`} aria-describedby={`setup-method-${id}`}
          disabled={!enabled} onClick={() => onChoose(id)}
          className={cn("flex min-w-0 flex-col items-start gap-3 rounded-2xl border border-border bg-background p-5 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", enabled ? "hover:border-muted-foreground hover:bg-secondary/60" : "opacity-60")}>
          <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-foreground"><Icon className="size-5" aria-hidden="true" /></span>
          <span className="text-base font-medium text-foreground">{title}</span>
          <span id={`setup-method-${id}`} className="flex flex-1 flex-col gap-3 text-muted-foreground">
            <span>{copy}</span>
            <span className="mt-auto text-xs">{enabled ? creates : pending ? "Checking availability…" : "Unavailable for this installation."}</span>
          </span>
        </button>
      })}
    </div>
    <details data-exact-permissions className="group">
      <summary className={cn("cursor-pointer text-center", onboardingLink)}>Show the exact permissions</summary>
      <div className="mt-2 hidden max-h-56 gap-4 group-open:grid overflow-y-auto text-left rounded-xl border border-border p-3 text-sm text-gray-600 @3xl:grid-cols-2" tabIndex={0} role="region" aria-label="Backup permissions by connection method">
        {permissions.map(({ label, names }) => <div key={label} className="min-w-0">
          <h3 className="font-medium text-gray-900">{label}</h3>
          <ul>{names.map(name => <li key={name} className="break-words">{name}</li>)}</ul>
        </div>)}
      </div>
    </details>
  </section>
}
