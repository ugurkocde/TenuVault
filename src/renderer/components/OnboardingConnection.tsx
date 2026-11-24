import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { bridge } from "../lib/bridge"

export function OtherTenant({ tenant, onChange, disabled, expectedTenant }: {
  tenant: string
  onChange: (tenant: string) => void
  disabled: boolean
  expectedTenant?: string
}) {
  return <details className="text-sm text-gray-700">
    <summary className="cursor-pointer underline underline-offset-2">
      {expectedTenant ? "Connection details" : "Setting up a different tenant? Enter its ID or domain"}
    </summary>
    <label className="mt-2 block max-w-md space-y-1">
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
  return <div className="space-y-2 rounded-2xl bg-secondary/60 px-4 py-3 text-sm text-gray-700">
    <p role="status" className="flex items-center gap-2">
      <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
      Finish signing in in your browser. This window updates by itself.
    </p>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="underline underline-offset-2" onClick={() => void reopen()}>Browser didn&apos;t open? Open it again</button>
      <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel"}</Button>
    </div>
    {message && <p role="status">{message}</p>}
  </div>
}
