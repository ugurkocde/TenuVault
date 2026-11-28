import { useState } from "react"
import { Loader2 } from "lucide-react"
import { onboardingLink } from "./OnboardingCard"
import { Input } from "~/components/ui/input"
import { bridge } from "../lib/bridge"

export function OtherTenant({ tenant, onChange, disabled, expectedTenant }: {
  tenant: string
  onChange: (tenant: string) => void
  disabled: boolean
  expectedTenant?: string
}) {
  return <details className="text-sm text-gray-700">
    <summary className={`cursor-pointer ${onboardingLink}`}>
      {expectedTenant ? "Connection details" : "Different tenant?"}
    </summary>
    <label className="mx-auto mt-3 block max-w-md space-y-1 text-left">
      <span>{expectedTenant ? "Tenant ID" : "Tenant ID or domain"}</span>
      <Input id={expectedTenant ? undefined : "setup-tenant"} value={tenant} onChange={event => onChange(event.target.value)} placeholder="contoso.onmicrosoft.com"
        disabled={disabled} readOnly={Boolean(expectedTenant)} spellCheck={false} autoComplete="off" />
    </label>
  </details>
}

export function BrowserSignInWait({ kind, cancel, cancelling = false }: {
  kind: "signin" | "setup" | "consent"
  cancel: () => void
  cancelling?: boolean
}) {
  const [message, setMessage] = useState("")
  const reopen = async () => {
    try {
      setMessage(await bridge.auth.reopenSignIn(kind) ? "" : "This browser session is no longer open.")
    } catch {
      setMessage("The browser could not be opened again.")
    }
  }
  return <div className="space-y-4 text-center text-sm text-muted-foreground">
    <div role="status" className="space-y-3">
      <Loader2 className="mx-auto size-8 motion-safe:animate-spin" aria-hidden="true" />
      <p>{kind === "consent" ? "Finish approving access in your browser." : "Finish signing in in your browser."}</p>
    </div>
    <div className="flex flex-wrap items-center justify-center gap-4">
      <button type="button" className={onboardingLink} onClick={() => void reopen()}>Open the browser again</button>
      <button type="button" className={onboardingLink} onClick={cancel} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel"}</button>
    </div>
    {message && <p role="status">{message}</p>}
  </div>
}
