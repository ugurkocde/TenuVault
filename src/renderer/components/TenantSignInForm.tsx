import { showCommunityLimitError } from "../lib/plan-dialog"
import { useEffect, useState } from "react"
import { AlertCircle, Check, Copy, ExternalLink, KeyRound, Loader2, ShieldCheck } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import setupScript from "../../../resources/New-TenuVaultDesktopApp.ps1?raw"
import type { SignedInAccount } from "../../shared/ipc"
import { DOCS_URL } from "../../shared/constants"
import { bridge } from "../lib/bridge"

const draft = { tenant: "", clientId: "", displayName: "" }

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export function SetupScriptCard({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(setupScript)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="space-y-3 rounded-3xl bg-blue-50/60 p-5 text-sm text-gray-700">
      <div className="flex items-center gap-3 text-base font-medium text-gray-900">
        <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-coral-500 text-white" aria-hidden="true">
          <ShieldCheck className="h-4 w-4" />
        </span>
        {compact ? "First time? Create the app registration in your tenant" : "Create the app registration"}
      </div>
      <p>
        Run the setup script in PowerShell as a Global Administrator or Cloud Application Administrator. It creates a
        public client app registration in your tenant, with no secret and delegated Intune permissions only, grants
        admin consent and prints the client id.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
          {copied ? "Copied" : "Copy setup script"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void bridge.app.openExternal(DOCS_URL)}>
          <ExternalLink className="mr-2 h-4 w-4" />
          Setup guide
        </Button>
      </div>
    </div>
  )
}

interface TenantSignInFormProps {
  onSignedIn: (account: SignedInAccount, displayName: string) => void
  submitLabel?: string
  initial?: { tenant: string; clientId: string; displayName: string }
}

/** Tenant, client id and optional display name, then interactive Microsoft sign-in. */
export function TenantSignInForm({ onSignedIn, submitLabel = "Sign in with Microsoft", initial }: TenantSignInFormProps) {
  const [tenant, setTenant] = useState(initial?.tenant ?? draft.tenant)
  const [clientId, setClientId] = useState(initial?.clientId ?? draft.clientId)
  const [displayName, setDisplayName] = useState(initial?.displayName ?? draft.displayName)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ tenant?: string; clientId?: string; form?: string }>({})

  useEffect(() => { Object.assign(draft, { tenant, clientId, displayName }) }, [tenant, clientId, displayName])

  const submit = async () => {
    // Enter can fire while a sign-in window is already open.
    if (busy) return
    const next: typeof errors = {}
    if (!GUID.test(tenant.trim()) && !DOMAIN.test(tenant.trim())) next.tenant = "Enter a tenant id or a domain such as contoso.onmicrosoft.com."
    if (!GUID.test(clientId.trim())) next.clientId = "The client id is a GUID, printed by the setup script."
    setErrors(next)
    if (next.tenant || next.clientId) { document.getElementById(next.tenant ? "tenant" : "clientId")?.focus(); return }

    setBusy(true)
    try {
      const account = await bridge.auth.signIn(tenant.trim(), clientId.trim())
      Object.assign(draft, { tenant: "", clientId: "", displayName: "" })
      onSignedIn(account, displayName.trim())
    } catch (error) {
      if (!showCommunityLimitError(error)) setErrors({ form: error instanceof Error ? error.message : "Sign-in failed." })
    } finally {
      setBusy(false)
    }
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, placeholder: string, error?: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        placeholder={placeholder}
        value={value}
        onChange={(e) => set(e.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={error ? "border-red-400 focus-visible:ring-red-400" : undefined}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
      />
      {error && <p id={`${id}-error`} className="text-xs text-red-700">{error}</p>}
    </div>
  )

  return (
    <div className="space-y-4">
      {field("tenant", "Tenant id or domain", tenant, setTenant, "contoso.onmicrosoft.com", errors.tenant)}
      {field("clientId", "Application (client) id", clientId, setClientId, "00000000-0000-0000-0000-000000000000", errors.clientId)}
      {field("displayName", "Display name (optional)", displayName, setDisplayName, "Contoso Production")}
      {errors.form && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{errors.form}</AlertDescription>
        </Alert>
      )}
      <Button onClick={() => void submit()} disabled={busy || !tenant || !clientId} className="w-full bg-blue-600 hover:bg-blue-700">
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
        {busy ? "Waiting for sign-in..." : submitLabel}
      </Button>
      {busy && <p className="text-center text-xs text-gray-500">Complete the sign-in in your browser.</p>}
    </div>
  )
}
