import { useEffect, useRef, useState } from "react"
import { AlertCircle, Building2, Check, ChevronDown, Circle, HardDrive, Info, KeyRound, Loader2, Send, ShieldCheck, Sparkles, UserCheck, X } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { APP_REGISTRATION_GUIDE_URL, CONSENT_ROLES_TEXT, MANUAL_APP_REGISTRATION_URL, setupHandoffText, suggestsCreatingByHand } from "../../shared/app-registration"
import type { RegistrationResult, SetupProgress } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { PermissionList, SetupScriptCard } from "./TenantSignInForm"

const CANCELLED = "Sign-in cancelled."

/** What the admin lets in, answered before the button: where it lives, what it may do, what it keeps. */
const REASONS = [
  { icon: Building2, title: "It lives in your tenant", text: "Setup creates one app registration in your own tenant. You can review or delete it in Entra at any time." },
  { icon: UserCheck, title: "It acts only as you", text: "Delegated permissions only. TenuVault acts as you, never on its own, so your roles, MFA and Conditional Access apply." },
  { icon: ShieldCheck, title: "No secret to protect", text: "No client secret and no certificate are created." },
  { icon: HardDrive, title: "Backups stay with you", text: "On this computer, or in Azure storage you own." },
] as const

const PHASES: readonly SetupProgress["phase"][] = ["signingIn", "registration", "consent", "publishing"]

/**
 * The Connect step: one button that signs the admin in and creates the tenant's app registration
 * through Microsoft Graph, with the reasons beside it and the other routes (another administrator,
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
    reused ? "Check its admin consent" : "Grant admin consent",
    "Wait until Microsoft accepts sign-ins to it",
  ]
  const current = PHASES.indexOf(phase)
  // The setup and the setup script sign in through the same Microsoft app. Where the tenant blocks
  // it, creating the app registration in the Entra admin center is the route that still works.
  const openManualGuide = () => void bridge.app.openExternal(MANUAL_APP_REGISTRATION_URL)

  return (
    <div data-tenant-connect className="grid items-start gap-5 text-sm text-gray-700 @3xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-2">
        <p className="text-base text-gray-600">One Microsoft sign-in. TenuVault creates its app registration in your tenant and signs you in.</p>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <p>{error}</p>
              {suggestsCreatingByHand(error) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={openManualGuide}>Create it by hand</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={onManual}>I already have an app registration</Button>
                </div>
              )}
            </AlertDescription>
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
                  If Microsoft says that you need admin approval, this account cannot approve the setup. Select Cancel and use
                  &quot;Someone else is the admin?&quot; below.
                </p>
                <p className="text-xs text-gray-600">
                  If Microsoft says that Microsoft Graph Command Line Tools is blocked, disabled or not assigned to you, or a
                  Conditional Access policy blocks it, the setup script is blocked too. Select Cancel and{" "}
                  <button type="button" className="rounded-sm font-medium text-gray-900 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={openManualGuide}>
                    create the app registration by hand
                  </button>
                  .
                </p>
                <p className="text-xs text-gray-600">
                  If Microsoft reports a device or compliance problem, Conditional Access needs a browser that passes the device
                  identity, such as Microsoft Edge signed in to your work profile. Make it your default browser, cancel and start
                  again.
                </p>
              </div>
            ) : (
              <p className="border-t border-gray-200 pt-4 text-xs text-gray-600">
                {phase === "publishing"
                  ? "Microsoft needs a moment before a new app registration can be used, usually a few seconds and at most a minute and a half. When it is ready, your browser opens once more to sign you in to TenuVault, with nothing to enter."
                  : "This takes a few seconds."}
              </p>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => void cancel()} disabled={cancelling}>
              <X className="mr-2 h-4 w-4" aria-hidden="true" />
              {cancelling ? "Cancelling..." : "Cancel"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* An app name the admin does not expect in a consent prompt looks like phishing, so it is announced here. */}
            <p className="flex items-start gap-2.5 rounded-2xl bg-gray-50 px-4 py-2 text-gray-700">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>
                Microsoft will ask you to approve <span className="font-medium text-gray-900">Microsoft Graph Command Line Tools</span>.
                That is Microsoft&apos;s own sign-in app. TenuVault uses it once to create the app registration; after that you
                sign in to TenuVault directly. Leave &quot;Consent on behalf of your organization&quot; unticked; the setup does not need it.
              </span>
            </p>
            <Button type="button" size="lg" className="w-full bg-blue-600 text-white hover:bg-blue-700 sm:w-auto" onClick={() => void start()}>
              <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
              {error ? "Try again" : "Set up with Microsoft sign-in"}
            </Button>
            <p className="text-xs text-gray-600">
              Sign in as a {CONSENT_ROLES_TEXT}, because the setup creates an app registration and grants admin consent. TenuVault
              connects tenants in Microsoft&apos;s global cloud; GCC High, DoD and 21Vianet tenants are not supported.
            </p>
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
              <li>TenuVault creates the app registration &quot;TenuVault Desktop&quot; in your tenant. If the tenant already has one from an earlier setup, it uses that one and changes nothing in it.</li>
              <li>It grants the app registration it created tenant-wide admin consent for the delegated permissions listed below, and nothing else.</li>
              <li>When Microsoft accepts sign-ins to the app registration, your browser opens once more and signs you in to TenuVault through it.</li>
            </ol>
            <p>
              The sign-in from step 1 is kept in memory only and dropped when the setup ends. Your approval of Microsoft Graph Command
              Line Tools stays with your account, as long as you leave &quot;Consent on behalf of your organization&quot; unticked; the
              setup does not need it. To remove it, open Entra admin center &gt; Enterprise applications &gt; Microsoft Graph Command
              Line Tools &gt; Permissions.
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

      </div>
      <ul className="space-y-4 rounded-2xl border border-border bg-muted/40 p-5">
        {REASONS.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3">
            <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-card text-gray-900" aria-hidden="true"><Icon className="h-4 w-4" /></span>
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium text-gray-900">{title}</p>
              <p className="text-gray-600">{text}</p>
            </div>
          </li>
        ))}
      </ul>
      {/* Under both columns, so the three ways sit in one row when there is room. */}
      <div className="space-y-2 border-t border-gray-100 pt-3 @3xl:col-span-2">
        <div>
          <p className="font-medium text-gray-900">Other ways to connect</p>
          <p className="text-gray-600">Not an administrator with one of these roles? Your administrator approves once, and you do the rest.</p>
        </div>
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
      </div>
      {script && (
        <div className="space-y-4 @3xl:col-span-2">
          <SetupScriptCard />
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={onManual}>Next: sign in</Button>
          </div>
        </div>
      )}
    </div>
  )
}
