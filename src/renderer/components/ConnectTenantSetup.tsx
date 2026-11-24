import { onboardingLink, onboardingPrimary } from "./OnboardingCard"
import { BrowserSignInWait, OtherTenant } from "./OnboardingConnection"
import { DEFAULT_SETUP_CHOICE, type PermissionChoice } from "../../shared/services/manifest"
import { useEffect, useRef, useState } from "react"
import { AlertCircle, Building2, Check, HardDrive, KeyRound, Loader2, Send, ShieldCheck, UserCheck } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { APP_REGISTRATION_GUIDE_URL, CONSENT_ROLES_TEXT, MANUAL_APP_REGISTRATION_URL, setupHandoffText, suggestsCreatingByHand } from "../../shared/app-registration"
import type { RegistrationResult, SetupProgress } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { PermissionList, SetupScriptCard } from "./TenantSignInForm"
import { SetupCallLink } from "./SetupCallLink"
import { recordSetup } from "./SetupDiagnostics"
import { SignInRecoveryPanel, useWaitedLong } from "./SignInRecovery"

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
export function ConnectTenantSetup({ onManual, onRegistered, onRunningChange, choice = DEFAULT_SETUP_CHOICE, expectedTenant, setupFile }: {
  choice?: PermissionChoice
  expectedTenant?: string
  onRunningChange?: (running: boolean) => void
  setupFile?: React.ReactNode
  /** Continue with IDs the admin already has, on the Sign in step. */
  onManual: () => void
  /** The app registration exists; the caller signs the admin in to it. */
  onRegistered: (result: RegistrationResult) => void
}) {
  const [tenant, setTenant] = useState(expectedTenant ?? "")
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<SetupProgress["phase"]>("signingIn")
  const [reused, setReused] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState("")
  // Whether the message is the error a setup attempt ended with. A cancel or a copy that failed
  // says nothing about the setup, so it does not offer the setup call.
  const [attemptFailed, setAttemptFailed] = useState(false)
  const [script, setScript] = useState(false)
  const [manualGuide, setManualGuide] = useState(false)
  const [copied, setCopied] = useState(false)
  const busy = useRef(false)
  // Try again in the recovery panel: the cancelled setup starts once more when it has ended.
  const restart = useRef(false)
  const [retrying, setRetrying] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Microsoft answered and the setup sign-in is completed: the browser step, and the panel, are over.
  const [completing, setCompleting] = useState(false)
  const waitedLong = useWaitedLong(running && phase === "signingIn" && !completing, attempt)

  useEffect(() => bridge.setup.onProgress((value) => {
    setPhase(value.phase)
    setCompleting(value.phase === "signingIn" && Boolean(value.completing))
    if (value.reused) setReused(true)
  }), [])

  const start = async (again = false) => {
    if (busy.current) return
    busy.current = true
    // A restart from the recovery panel is the same route, not a new choice.
    if (!again) recordSetup({ name: "setup_route", props: { route: "auto" } })
    setAttempt((value) => value + 1)
    setRunning(true)
    onRunningChange?.(true)
    setCancelling(false)
    setError("")
    setAttemptFailed(false)
    setReused(false)
    setPhase("signingIn")
    setCompleting(false)
    let restartNow = false
    try {
      onRegistered(await bridge.setup.createRegistration({ ...(tenant.trim() ? { tenant: tenant.trim() } : {}), choice }))
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      restartNow = message === CANCELLED && restart.current
      // Cancelling is the admin's own choice, not something to report back to them.
      if (message !== CANCELLED) {
        setError(message)
        setAttemptFailed(true)
      }
    } finally {
      busy.current = false
      restart.current = false
      setRunning(false)
      onRunningChange?.(false)
      setRetrying(false)
    }
    if (restartNow) void start(true)
  }

  const cancel = async () => {
    setCancelling(true)
    try {
      await bridge.setup.cancelCreateRegistration()
    } catch (caught) {
      setCancelling(false)
      setError(caught instanceof Error ? caught.message : String(caught))
      setAttemptFailed(false)
    }
  }

  // Cancels only the browser wait and starts again. When the sign-in has already come back, the main
  // process has nothing to cancel and says so: the setup goes on and nothing restarts.
  const tryAgain = async () => {
    restart.current = true
    setRetrying(true)
    try {
      if (await bridge.setup.cancelSignIn()) return
      restart.current = false
      setRetrying(false)
    } catch (caught) {
      restart.current = false
      setRetrying(false)
      setError(caught instanceof Error ? caught.message : String(caught))
      setAttemptFailed(false)
    }
  }

  const copyHandoff = async () => {
    setError("")
    setAttemptFailed(false)
    recordSetup({ name: "setup_route", props: { route: "handoff" } })
    try {
      await navigator.clipboard.writeText(setupHandoffText(choice))
      setCopied(true)
    } catch (caught) {
      // The copy can fail after a setup attempt that started meanwhile has failed.
      setError(`Could not copy: ${caught instanceof Error ? caught.message : String(caught)}`)
      setAttemptFailed(false)
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
  const openManualGuide = () => setManualGuide(true)
  const manual = () => {
    recordSetup({ name: "setup_route", props: { route: "manual" } })
    onManual()
  }
  const toggleScript = () => {
    if (!script) recordSetup({ name: "setup_route", props: { route: "script" } })
    setScript(!script)
  }

  return (
    <div data-tenant-connect className="space-y-4 text-center text-sm text-muted-foreground">
      <div className="min-w-0 space-y-2">
        {!running && <p>TenuVault creates an app registration and signs you in through it.</p>}

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <p>{error}</p>
              {suggestsCreatingByHand(error) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={openManualGuide}>Create it by hand</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={manual}>I already have an app registration</Button>
                </div>
              )}
              {attemptFailed && <SetupCallLink source="setup-error" variant="hint" className="mt-3" />}
            </AlertDescription>
          </Alert>
        )}

        {running ? (
          <div className="space-y-4 pt-3">
            {phase === "signingIn" && !completing ? (
              <BrowserSignInWait kind="setup" cancel={() => void cancel()} cancelling={cancelling} />
            ) : (
              <>
                <div role="status" className="space-y-3">
                  <Loader2 className="mx-auto size-8 motion-safe:animate-spin" aria-hidden="true" />
                  <p>{completing ? "Completing sign-in..." : phase === "publishing" ? "Microsoft may take up to 90 seconds before your browser opens again." : steps[current]}</p>
                </div>
                <button type="button" className={onboardingLink} onClick={() => void cancel()} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel"}</button>
              </>
            )}
            {setupFile}
            {waitedLong && <SignInRecoveryPanel choice={choice} kind="setup" onTryAgain={() => void tryAgain()} retrying={retrying} />}
          </div>
        ) : (
          <div className="space-y-3">
            <Button type="button" className={onboardingPrimary} onClick={() => void start()}>
              <KeyRound className="size-4" aria-hidden="true" />
              {error ? "Try again" : "Set up with Microsoft sign-in"}
            </Button>
            <p className="mx-auto max-w-md text-xs">
              Microsoft will ask you to approve Microsoft Graph Command Line Tools for setup. Leave &quot;Consent on behalf of your organization&quot; unticked.
            </p>
            <OtherTenant tenant={tenant} onChange={setTenant} disabled={running} expectedTenant={expectedTenant} />
          </div>
        )}

      </div>
      {!running && <>
        <details open={manualGuide || script || copied || undefined} className="space-y-3">
          <summary className={`cursor-pointer ${onboardingLink}`}>Can&apos;t sign in as an admin here?</summary>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={running} onClick={() => void copyHandoff()}>
              {copied ? <Check className="mr-2 h-4 w-4" aria-hidden="true" /> : <Send className="mr-2 h-4 w-4" aria-hidden="true" />}
              {copied ? "Copied" : "Copy instructions for my admin"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={running} onClick={openManualGuide}>Create it by hand</Button>
            <Button type="button" variant="ghost" size="sm" disabled={running} onClick={toggleScript} aria-expanded={script}>
              Use the setup script instead
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={running} onClick={manual}>
              I already have an app registration
            </Button>
          </div>
          {setupFile}
          {copied && (
            <p role="status" className="text-xs text-gray-600">
              Send the instructions to your Entra administrator by email or chat. TenuVault keeps your place here, so you can close
              it. When they send back the two lines, select &quot;I already have an app registration&quot; and paste them.
            </p>
          )}
          {manualGuide && <section className="space-y-3 rounded-2xl bg-secondary/60 p-4 @3xl:col-span-2"><h3 className="font-medium text-gray-900">Create the app registration manually</h3><p>Create a single-tenant public client with a localhost redirect, no secret and no certificate. Add and consent to the delegated permissions for your choice below, then return with the tenant ID and client ID.</p><PermissionList choice={choice} /><Button variant="outline" onClick={() => void bridge.app.openExternal(MANUAL_APP_REGISTRATION_URL)}>Open the manual guide</Button></section>}
          {copied && <details className="rounded-2xl bg-secondary/60 p-4 @3xl:col-span-2" open><summary className="font-medium">Instructions for your administrator</summary><pre className="mt-3 whitespace-pre-wrap break-words text-xs">{setupHandoffText(choice)}</pre></details>}
          {script && (
            <div className="space-y-4 @3xl:col-span-2">
              <SetupScriptCard choice={choice} />
              <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={onManual}>Next: sign in</Button>
              </div>
            </div>
          )}
        </details>
        <details className="space-y-3">
          <summary className={`cursor-pointer ${onboardingLink}`}>
            What the setup does
          </summary>
          <div className="mt-3 space-y-4 rounded-2xl bg-secondary/60 p-4 text-left">
            <ul className="space-y-2 rounded-2xl border border-border bg-muted/40 p-4">
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
            <p>Sign in as a {CONSENT_ROLES_TEXT}, because the setup creates an app registration and grants admin consent. Setup supports Microsoft's global cloud. GCC High, DoD and 21Vianet tenants are not supported.</p>
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
            <div className="rounded-2xl bg-gray-50"><PermissionList choice={choice} /></div>
            <Button type="button" variant="ghost" size="sm" onClick={() => void bridge.app.openExternal(APP_REGISTRATION_GUIDE_URL)}>
              Setup guide
            </Button>
          </div>
        </details>
      </>}
    </div>
  )
}
