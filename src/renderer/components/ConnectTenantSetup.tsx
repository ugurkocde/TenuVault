import { useEffect, useRef, useState } from "react"
import { AlertCircle, Building2, Check, ChevronDown, Circle, HardDrive, KeyRound, Loader2, Send, ShieldCheck, Sparkles, UserCheck, X } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { APP_REGISTRATION_GUIDE_URL, CONSENT_ROLES, setupHandoffText } from "../../shared/app-registration"
import type { RegistrationResult, SetupProgress } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { PermissionList, SetupScriptCard } from "./TenantSignInForm"

const CANCELLED = "Sign-in cancelled."

/** Why the admin can agree to the setup, in the order they ask themselves these questions. */
const REASONS = [
  { icon: Building2, title: "It lives in your tenant", text: "Setup creates one app registration in your own tenant. You can delete it in Entra at any time." },
  { icon: UserCheck, title: "It acts only as you", text: "Delegated permissions, no secret and no background access. Your roles, MFA and Conditional Access apply to every call." },
  { icon: HardDrive, title: "Backups stay with you", text: "On this computer or in your own Azure storage." },
  { icon: ShieldCheck, title: "Microsoft asks for one approval", text: "The prompt names Microsoft Graph Command Line Tools. That is Microsoft's own sign-in app, used here once to create the app registration." },
] as const

const PHASES: readonly SetupProgress["phase"][] = ["signingIn", "registration", "consent", "publishing"]

/**
 * The Connect step: one button that signs the admin in and creates the tenant's app registration
 * through Microsoft Graph, with the reasons first and the other routes (another administrator,
 * the setup script, an existing app registration) below.
 */
export function ConnectTenantSetup({ trials, onManual, onRegistered }: {
  /** Whether new tenants start with a Pro trial, announced before the setup starts. */
  trials: boolean
  /** Continue with IDs the admin already has, on the Sign in step. */
  onManual: () => void
  /** The app registration exists; the caller signs the admin in to it. */
  onRegistered: (result: RegistrationResult) => void
}) {
  const [tenant, setTenant] = useState("")
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<SetupProgress["phase"]>("signingIn")
  const [reused, setReused] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState("")
  const [script, setScript] = useState(false)
  const [copied, setCopied] = useState(false)
  const busy = useRef(false)

  useEffect(() => bridge.setup.onProgress((value) => {
    setPhase(value.phase)
    if (value.reused) setReused(true)
  }), [])

  const start = async () => {
    if (busy.current) return
    busy.current = true
    setRunning(true)
    setCancelling(false)
    setError("")
    setReused(false)
    setPhase("signingIn")
    try {
      onRegistered(await bridge.setup.createRegistration(tenant.trim() ? { tenant: tenant.trim() } : undefined))
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      // Cancelling is the admin's own choice, not something to report back to them.
      if (message !== CANCELLED) setError(message)
    } finally {
      busy.current = false
      setRunning(false)
    }
  }

  const cancel = async () => {
    setCancelling(true)
    try {
      await bridge.setup.cancelCreateRegistration()
    } catch (caught) {
      setCancelling(false)
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const copyHandoff = async () => {
    setError("")
    try {
      await navigator.clipboard.writeText(setupHandoffText())
      setCopied(true)
    } catch (caught) {
      setError(`Could not copy: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }

  const steps = [
    "Sign in with Microsoft in your browser",
    reused ? "Use the app registration this tenant already has" : "Create the app registration",
    "Grant admin consent",
    "Wait until Microsoft accepts sign-ins to it",
  ]
  const current = PHASES.indexOf(phase)
  const roles = `${CONSENT_ROLES.slice(0, -1).join(", ")} or ${CONSENT_ROLES.at(-1)}`

  return (
    <div data-tenant-connect className="space-y-6 text-sm text-gray-700">
      <p className="text-base text-gray-600">One Microsoft sign-in, about two minutes.</p>

      <ul className="grid gap-3 sm:grid-cols-2">
        {REASONS.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3 rounded-2xl bg-blue-50/60 p-4">
            <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-card text-gray-900" aria-hidden="true"><Icon className="h-4 w-4" /></span>
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium text-gray-900">{title}</p>
              <p className="text-gray-600">{text}</p>
            </div>
          </li>
        ))}
      </ul>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {running ? (
        <div role="status" aria-live="polite" className="space-y-4 rounded-3xl bg-gray-50 p-5">
          <p className="font-medium text-gray-900">Setting up your tenant</p>
          <ol className="space-y-2.5">
            {steps.map((label, index) => (
              <li key={PHASES[index]} className={`flex items-center gap-2.5 ${index > current ? "text-gray-500" : "text-gray-900"}`} aria-current={index === current ? "step" : undefined}>
                {index < current
                  ? <Check className="h-4 w-4 flex-shrink-0 text-green-700" aria-hidden="true" />
                  : index === current
                    ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" aria-hidden="true" />
                    : <Circle className="h-4 w-4 flex-shrink-0 text-gray-300" aria-hidden="true" />}
                <span>{label}<span className="sr-only">{index < current ? " (done)" : index === current ? " (in progress)" : ""}</span></span>
              </li>
            ))}
          </ol>
          {phase === "signingIn" ? (
            <div className="space-y-3 border-t border-gray-200 pt-4">
              <p>Choose your admin account in the browser and approve the request. Nothing is created before you are signed in.</p>
              <p className="text-xs text-gray-600">
                If Microsoft reports a device or compliance problem, Conditional Access needs a browser that passes the device
                identity, such as Microsoft Edge signed in to your work profile. Make it your default browser, cancel and start
                again.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void cancel()} disabled={cancelling}>
                <X className="mr-2 h-4 w-4" aria-hidden="true" />
                {cancelling ? "Cancelling..." : "Cancel"}
              </Button>
            </div>
          ) : (
            <p className="border-t border-gray-200 pt-4 text-xs text-gray-600">
              This takes a few seconds. Afterwards your browser opens once more to sign you in to TenuVault, with nothing to enter.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <Button type="button" size="lg" className="w-full bg-blue-600 text-white hover:bg-blue-700 sm:w-auto" onClick={() => void start()}>
            <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
            {error ? "Try again" : "Set up with Microsoft sign-in"}
          </Button>
          <p className="text-xs text-gray-600">Sign in as a {roles}, because the setup grants admin consent.</p>
          {trials && (
            <p className="flex items-center gap-2 text-sm text-gray-700">
              <Sparkles className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              New tenants start with a Pro trial. No card and no email needed.
            </p>
          )}
        </div>
      )}

      {/* A named group, so the chevron of the permission list inside follows its own state. */}
      <details className="group/setup rounded-2xl border border-gray-200 px-4 py-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-medium text-gray-900">
          What the setup does
          <ChevronDown className="h-4 w-4 transition-transform group-open/setup:rotate-180" aria-hidden="true" />
        </summary>
        <div className="mt-3 space-y-4">
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>Your browser opens and you sign in with Microsoft. Microsoft asks you to approve Microsoft Graph Command Line Tools with two permissions: Application.ReadWrite.All and DelegatedPermissionGrant.ReadWrite.All.</li>
            <li>TenuVault creates the app registration &quot;TenuVault Desktop&quot; in your tenant. If the tenant already has one from an earlier setup, it uses that one.</li>
            <li>It grants tenant-wide admin consent for the delegated permissions listed below, and nothing else.</li>
            <li>Your browser opens once more and signs you in to TenuVault through the new app registration.</li>
          </ol>
          <p>
            The sign-in from step 1 is kept in memory only and dropped when the setup ends. Your approval of Microsoft Graph Command
            Line Tools stays with your account. To remove it, open Entra admin center &gt; Enterprise applications &gt; Microsoft
            Graph Command Line Tools &gt; Permissions.
          </p>
          <div className="rounded-2xl bg-gray-50"><PermissionList /></div>
          <div className="space-y-1.5">
            <Label htmlFor="setup-tenant">Tenant ID or domain (optional)</Label>
            <Input
              id="setup-tenant"
              name="setup-tenant"
              placeholder="contoso.onmicrosoft.com"
              value={tenant}
              onChange={(event) => setTenant(event.target.value)}
              disabled={running}
              spellCheck={false}
              autoComplete="off"
              aria-describedby="setup-tenant-help"
            />
            <p id="setup-tenant-help" className="text-xs text-gray-600">
              Only for guest and partner admins who set up a tenant other than their own. Leave it empty to use the tenant of the
              account you sign in with.
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => void bridge.app.openExternal(APP_REGISTRATION_GUIDE_URL)}>
            Setup guide
          </Button>
        </div>
      </details>

      <div className="space-y-3 border-t border-gray-100 pt-5">
        <p className="font-medium text-gray-900">Other ways to connect</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={running} onClick={() => void copyHandoff()}>
            {copied ? <Check className="mr-2 h-4 w-4" aria-hidden="true" /> : <Send className="mr-2 h-4 w-4" aria-hidden="true" />}
            {copied ? "Copied" : "Someone else is the admin? Copy instructions"}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={running} onClick={() => setScript(!script)} aria-expanded={script}>
            Use the setup script instead
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={running} onClick={onManual}>
            I already have an app registration
          </Button>
        </div>
        {copied && (
          <p role="status" className="text-xs text-gray-600">
            Send the instructions to your Entra administrator by email or chat. TenuVault keeps your place here, so you can close
            it. When they send back the two lines, select &quot;I already have an app registration&quot; and paste them.
          </p>
        )}
        {script && (
          <div className="space-y-4">
            <SetupScriptCard />
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={onManual}>Next: sign in</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
