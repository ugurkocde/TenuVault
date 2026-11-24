import { Cloud, KeyRound, Zap } from "lucide-react"
import { Button } from "~/components/ui/button"
import { SIGN_IN_METHODS, type SignInMethod } from "../../shared/tenant-connection"
import { graphPermissions, type PermissionChoice } from "../../shared/services/manifest"
import { tenantPermissionPacks } from "../../shared/services/permission-packs"

const CARDS = [
  { id: "graphCli", Icon: Zap, copy: "Fastest setup. Backup only. Nothing is created in your tenant." },
  { id: "tenuvaultApp", Icon: Cloud, copy: "An admin approves backup access. You can add restore access later." },
  { id: "ownApp", Icon: KeyRound, copy: "For organizations that require their own app registration." },
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
  return <section className="space-y-4" aria-labelledby="setup-step--2">
    <h2 id="setup-step--2" tabIndex={-1} className="text-2xl font-medium tracking-tight text-gray-900 outline-none">How do you want to connect?</h2>
    <div className="grid gap-3 @3xl:grid-cols-3">
      {CARDS.map(({ id, Icon, copy }) => {
        const title = SIGN_IN_METHODS[id]
        const enabled = id === "ownApp" || available[id] === true
        const pending = id !== "ownApp" && available[id] === null
        return <section key={id} data-sign-in-method={id} aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-background p-4 text-sm text-gray-700">
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-gray-700"><Icon className="size-4" aria-hidden="true" /></span>
            <h3 className="font-medium text-gray-900">{title}</h3>
          </div>
          <p>{copy}</p>
          <Button variant="outline" className="mt-auto h-auto min-h-9 w-full whitespace-normal text-center" disabled={!enabled} onClick={() => onChoose(id)}>Choose {title}</Button>
          {!enabled && <p role="status" className="text-xs text-gray-600">{pending ? "Checking availability…" : "Unavailable. The license service has not enabled this method."}</p>}
        </section>
      })}
    </div>
    <details data-exact-permissions className="group">
      <summary className="cursor-pointer text-sm font-medium text-blue-700 underline underline-offset-2">Show the exact permissions</summary>
      <div className="mt-2 hidden max-h-56 gap-4 group-open:grid overflow-y-auto rounded-xl border border-border p-3 text-sm text-gray-600 @3xl:grid-cols-2" tabIndex={0} role="region" aria-label="Backup permissions by connection method">
        {permissions.map(({ label, names }) => <div key={label} className="min-w-0">
          <h3 className="font-medium text-gray-900">{label}</h3>
          <ul>{names.map(name => <li key={name} className="break-words">{name}</li>)}</ul>
        </div>)}
      </div>
    </details>
  </section>
}
