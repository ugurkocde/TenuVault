import { useEffect, useRef, useState } from "react"
import { Check, Loader2, ShieldCheck } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { CONSENT_ROLES, APP_REGISTRATION_GUIDE_URL, MANUAL_APP_REGISTRATION_URL, setupHandoffText } from "../../shared/app-registration"
import type { RegistrationResult, SetupProgress, SignedInAccount } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { showCommunityLimitError } from "../lib/plan-dialog"
import { PermissionList, SetupScriptCard } from "./TenantSignInForm"

const PHASES = ["signingIn", "checking", "registration", "consent", "publishing", "signIn"] as const

export function ConnectTenantSetup({ trials, onManual, onRegistered, onSignedIn, onSignInFailed }: {
  trials: boolean
  onManual: () => void
  onRegistered: (result: RegistrationResult) => void
  onSignedIn: (account: SignedInAccount) => void
  onSignInFailed: (message: string) => void
}) {
  const [tenant, setTenant] = useState("")
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SetupProgress | { phase: "signIn" }>({ phase: "signingIn" })
  const [reused, setReused] = useState(false)
  const [error, setError] = useState("")
  const [script, setScript] = useState(false)
  const [copied, setCopied] = useState(false)
  const busy = useRef(false)
  useEffect(() => bridge.setup.onProgress(value => { setProgress(value); if (value.reused) setReused(true) }), [])
  const start = async () => {
    if (busy.current) return
    busy.current = true
    setRunning(true)
    setError("")
    setReused(false)
    setProgress({ phase: "signingIn" })
    try {
      const result = await bridge.setup.createRegistration(tenant.trim() ? { tenant: tenant.trim() } : undefined)
      onRegistered(result)
      if (!result.ready) {
        onSignInFailed("Microsoft is still publishing the app registration. Wait a moment, then sign in.")
        return
      }
      setProgress({ phase: "signIn" })
      // Give the browser notice a render before opening the second sign-in.
      await new Promise(resolve => setTimeout(resolve, 100))
      try { onSignedIn(await bridge.auth.signIn(result.tenantId, result.clientId, { loginHint: result.username })) }
      catch (caught) { onSignInFailed(caught instanceof Error ? caught.message : String(caught)) }
    } catch (caught) {
      if (!showCommunityLimitError(caught)) setError(caught instanceof Error ? caught.message : String(caught))
    } finally { busy.current = false; setRunning(false) }
  }
  const labels = ["Sign in with Microsoft in your browser", "Check the tenant", reused ? "Found the existing app registration" : "Create the app registration", "Grant admin consent", "Wait for Microsoft to publish it", "Sign in to TenuVault"]
  return <div data-tenant-connect className="space-y-5 text-sm text-gray-700">
    <p>One Microsoft sign-in, about two minutes.</p>
    <ul className="space-y-3">
      {[
        "Creates one app registration in your own tenant. You can delete it in Entra at any time.",
        "TenuVault acts only as the signed-in admin: delegated permissions, no secret, no background access.",
        "Backups stay on this computer or in your own Azure storage.",
        "Microsoft will ask you to approve Microsoft Graph Command Line Tools. That is Microsoft's own sign-in app, used here once to create the app registration.",
      ].map(reason => <li key={reason} className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{reason}</span></li>)}
    </ul>
    {trials && <p>New tenants start with a Pro trial. No card and no email needed.</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {running ? <div role="status" aria-live="polite" className="space-y-3 rounded-2xl bg-blue-50 p-4">
      <ol className="space-y-2">{labels.map((label, i) => {
        const current = PHASES.indexOf(progress.phase)
        return <li key={PHASES[i]} className="flex gap-2" aria-current={i === current ? "step" : undefined}>
          {i < current ? <Check className="size-4" aria-hidden="true" /> : i === current ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <span className="size-4" aria-hidden="true" />}
          <span>{label}{i < current ? " (done)" : ""}</span>
        </li>
      })}</ol>
      {progress.phase === "signingIn" && <>
        <p>Use a browser profile that passes your device identity, such as Microsoft Edge signed in to your work profile, if Conditional Access requires it.</p>
        <Button variant="outline" onClick={() => void bridge.setup.cancelCreateRegistration().catch(caught => setError(String(caught)))}>Cancel</Button>
      </>}
      {progress.phase === "signIn" && <><p>Your browser opens once more. There is nothing to enter this time.</p><Button variant="outline" onClick={() => void bridge.auth.cancelSignIn()}>Cancel sign-in</Button></>}
    </div> : <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void start()}>{error ? "Try again" : "Set up with Microsoft sign-in"}</Button>}
    <p className="text-xs">Use a {CONSENT_ROLES.join(", ")}, because the setup grants admin consent.</p>
    <details className="space-y-3 rounded-2xl border p-4">
      <summary className="cursor-pointer font-medium">What the setup does</summary>
      <ol className="list-decimal space-y-1 pl-5"><li>Sign in with Microsoft.</li><li>Create or reuse the TenuVault app registration in your tenant.</li><li>Grant admin consent for the listed permissions.</li><li>Sign you in to TenuVault.</li></ol>
      <p>The admins who use TenuVault need an Intune role, for example Intune Administrator.</p>
      <PermissionList />
      <p>You approve Microsoft Graph Command Line Tools with Application.ReadWrite.All and DelegatedPermissionGrant.ReadWrite.All. TenuVault keeps that token in memory only for this setup.</p>
      <p>The approval stays with your admin account afterwards. Remove it in Entra admin center &gt; Enterprise applications &gt; Microsoft Graph Command Line Tools &gt; Permissions.</p>
      <Label htmlFor="setup-tenant">Tenant ID or domain</Label>
      <Input id="setup-tenant" value={tenant} onChange={event => setTenant(event.target.value)} disabled={running} aria-describedby="setup-tenant-help" />
      <p id="setup-tenant-help">Optional, for guest or partner admins. Leave empty to use the tenant of the account you sign in with.</p>
    </details>
    <div className="flex flex-wrap gap-2">
      <Button variant="ghost" disabled={running} onClick={() => void navigator.clipboard.writeText(setupHandoffText()).then(() => setCopied(true)).catch(caught => setError(String(caught)))}>Someone else is the admin? Copy instructions</Button>
      <Button variant="ghost" disabled={running} onClick={() => setScript(!script)} aria-expanded={script}>Use the setup script instead</Button>
      <Button variant="ghost" disabled={running} onClick={onManual}>I already have an app registration</Button>
      <Button variant="ghost" onClick={() => void bridge.app.openExternal(MANUAL_APP_REGISTRATION_URL)}>Create it by hand instead</Button>
      <Button variant="ghost" onClick={() => void bridge.app.openExternal(APP_REGISTRATION_GUIDE_URL)}>Setup guide</Button>
    </div>
    {copied && <p role="status">Send the instructions to your Entra administrator. Continue on the Sign in step when the two lines come back. <Button variant="link" onClick={onManual}>Continue to Sign in</Button></p>}
    {script && <><SetupScriptCard /><Button variant="outline" onClick={onManual}>Next: sign in</Button></>}
  </div>
}
