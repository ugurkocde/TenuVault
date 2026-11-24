import { Cloud, KeyRound, Zap } from "lucide-react"
import { Button } from "~/components/ui/button"
import { SIGN_IN_METHODS, type SignInMethod } from "../../shared/tenant-connection"

const CARDS = [
  {
    id: "graphCli", Icon: Zap,
    copy: "Sign in with Microsoft Graph Command Line Tools. Nothing is created in your tenant. TenuVault uses what your tenant already allows this Microsoft app, and shows exactly what it can back up.",
    creates: "Nothing",
    roles: "Any admin",
  },
  {
    id: "tenuvaultApp", Icon: Cloud,
    copy: "One verified TenuVault app in your tenant. No secrets, nothing reachable from outside. An administrator approves it once, or you send them a link.",
    creates: "One TenuVault enterprise app",
    roles: "Application, Cloud Application or Global Administrator approves",
  },
  {
    id: "ownApp", Icon: KeyRound,
    copy: "For organizations that require their own app. TenuVault creates it with one sign-in, or you use the script or an existing registration.",
    creates: "One app registration if you create one",
    roles: "Application Administrator or higher to create it",
  },
] as const

export type MethodAvailability = Record<"graphCli" | "tenuvaultApp", boolean | null>

export function OnboardingSignIn({ available, onChoose }: { available: MethodAvailability; onChoose: (method: SignInMethod) => void }) {
  return <section className="space-y-4" aria-labelledby="setup-step--2">
    <div className="space-y-1">
      <h2 id="setup-step--2" tabIndex={-1} className="text-2xl font-medium tracking-tight text-gray-900 outline-none">Let&apos;s sign in</h2>
      <p className="text-sm text-gray-600">Choose how TenuVault signs in to your tenant. You can change this later for new tenants.</p>
    </div>
    <div className="grid gap-3 @3xl:grid-cols-3">
      {CARDS.map(({ id, Icon, copy, creates, roles }) => {
        const title = SIGN_IN_METHODS[id]
        const enabled = id === "ownApp" || available[id] === true
        const pending = id !== "ownApp" && available[id] === null
        return <section key={id} data-sign-in-method={id} aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-background p-4 text-sm text-gray-700">
          <div className="min-h-12 space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-gray-700"><Icon className="size-4" aria-hidden="true" /></span>
              <h3 className="font-medium text-gray-900">{title}</h3>
            </div>
            {id === "tenuvaultApp" && <p className="text-xs font-medium text-gray-700">Recommended for full backup</p>}
          </div>
          <p>{copy}</p>
          <dl className="mt-auto space-y-2 border-t border-border pt-3 text-xs">
            <div><dt className="font-medium text-gray-900">What this creates in your tenant</dt><dd>{creates}</dd></div>
            <div><dt className="font-medium text-gray-900">Roles</dt><dd>{roles}</dd></div>
          </dl>
          <div className="min-h-16 space-y-2">
            <Button variant="outline" className="h-auto min-h-9 w-full whitespace-normal text-center" disabled={!enabled} onClick={() => onChoose(id)}>Choose {title}</Button>
            {!enabled && <p role="status" className="text-xs text-gray-600">{pending ? "Checking availability…" : "Unavailable. The license service has not enabled this method."}</p>}
          </div>
        </section>
      })}
    </div>
  </section>
}
