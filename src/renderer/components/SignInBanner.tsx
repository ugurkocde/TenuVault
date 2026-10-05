import { useEffect, useState } from "react"
import { KeyRound, Loader2, X } from "lucide-react"
import { useTenants } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import type { SignInRequiredEvent } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { toast } from "../lib/toast"

/**
 * Shown when a background request needs the admin to sign in again (expired session,
 * Conditional Access step-up). Signing in never starts without the admin asking.
 */
export function SignInBanner() {
  const tenants = useTenants()
  const [pending, setPending] = useState<SignInRequiredEvent | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => bridge.auth.onSignInRequired((event) => setPending((current) => current ?? event)), [])

  if (!pending) return null
  const tenant = tenants.find((t) => t.credentials?.tenantId?.toLowerCase() === pending.tenantId.toLowerCase())

  const signIn = async () => {
    setBusy(true)
    try {
      const account = await bridge.auth.reauthenticate(pending.tenantId, pending.clientId, pending.scope)
      setPending(null)
      toast(`Signed in as ${account.username}. Reloading...`, "success")
      setTimeout(() => window.location.reload(), 800)
    } catch (error) {
      toast(error instanceof Error ? error.message : "Sign-in failed.", "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-6 pt-5 lg:px-8">
    <div className="flex items-center gap-3 rounded-3xl bg-amber-50 py-2 pl-2 pr-2 text-sm text-amber-900">
      <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-card text-amber-700" aria-hidden="true">
        <KeyRound className="h-4 w-4" />
      </span>
      <p className="flex-1">
        <span className="font-medium">{tenant?.name ?? pending.tenantId}: </span>
        {pending.message}
      </p>
      <Button size="sm" onClick={() => void signIn()} disabled={busy}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Sign in
      </Button>
      <button type="button" onClick={() => setPending(null)} className="flex size-9 flex-shrink-0 items-center justify-center rounded-full text-amber-700 transition-colors hover:bg-amber-100" aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
    </div>
  )
}
