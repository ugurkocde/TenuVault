import { trialKeyRefusalText } from "../../shared/trial-notices"
import { showCommunityLimitError } from "../lib/plan-dialog"
import { TrialKeyRefusalActions } from "./TenantTrial"
import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react"
import { AlertCircle, Check, ChevronDown, ClipboardPaste, Copy, Download, ExternalLink, KeyRound, Loader2, Send, ShieldCheck, X } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import setupScript from "../../../resources/New-TenuVaultDesktopApp.ps1?raw"
import type { SignedInAccount } from "../../shared/ipc"
import {
  APP_REGISTRATION_GUIDE_URL,
  CONSENT_ROLES,
  DESKTOP_APP_PERMISSIONS,
  MANUAL_APP_REGISTRATION_URL,
  parseSetupOutput,
  SETUP_SCRIPT_FILE_NAME,
  setupHandoffText,
} from "../../shared/app-registration"
import { bridge } from "../lib/bridge"

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i
const CANCELLED = "Sign-in cancelled."

/** A PowerShell single-quoted string. PowerShell also ends one at a typographic single quote, so each one inside is doubled too. */
const psQuote = (value: string) => `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (quote) => quote + quote)}'`

/** The PowerShell command that runs the saved script: change to its folder when known, then run it. */
export function setupCommand(folder?: string, fileName = SETUP_SCRIPT_FILE_NAME): string {
  const run = /^[\w.-]+$/.test(fileName) ? `./${fileName}` : `& ${psQuote(`./${fileName}`)}`
  return folder ? `cd ${psQuote(folder)}\n${run}` : run
}

function useCopied(): [string | null, (id: string, text: string) => Promise<void>, string] {
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState("")
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async (id: string, text: string) => {
    setError("")
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(null), 2500)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }
  return [copied, copy, error]
}

function Step({ number, title, children }: { number: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-7 flex-shrink-0 items-center justify-center rounded-full bg-card text-sm font-semibold text-gray-900" aria-hidden="true">{number}</span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <p className="font-medium text-gray-900">{title}</p>
        {children}
      </div>
    </li>
  )
}

function CommandLine({ command, label, copied, onCopy }: { command: string; label: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl bg-slate-900 py-2 pl-4 pr-2">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all py-1 font-mono text-xs text-slate-100">{command}</code>
      <Button type="button" size="sm" variant="ghost" className="text-slate-100 hover:bg-slate-800 hover:text-white" onClick={onCopy} aria-label={label}>
        {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      </Button>
    </div>
  )
}

/** The permissions the setup script grants, so the admin who consents sees them first. */
export function PermissionList() {
  return (
    <details className="group rounded-2xl bg-card px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-medium text-gray-900">
        Permissions the app registration gets
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="mt-3 space-y-3 text-sm text-gray-700">
        <p>
          The setup grants tenant-wide admin consent for these delegated permissions. Every call still runs as the admin
          who signs in, so it is limited by their own Intune role, MFA and Conditional Access.
        </p>
        <ul className="space-y-2">
          {DESKTOP_APP_PERMISSIONS.map((entry) => (
            <li key={entry.api}>
              <span className="font-medium text-gray-900">{entry.api}:</span> <span className="font-mono text-xs">{entry.permissions.join(", ")}</span>
              <span className="block text-xs text-gray-600">{entry.purpose}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-gray-600">
          By default any user of the tenant can sign in to the app registration, but gets no more than their own roles
          allow. To limit sign-in, assign an admin group to the enterprise application in Entra and turn on Assignment required (needs Entra ID P1 or P2). The script also supports <code className="font-mono">-AllowedGroupId</code>.
        </p>
      </div>
    </details>
  )
}

/**
 * Creating the app registration, step by step: save the script, run it, sign in, bring back the
 * two values it prints. Offers the handoff to another administrator and the manual route.
 */
export function SetupScriptCard() {
  const [saved, setSaved] = useState<{ folder?: string; fileName?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")
  const [copied, copy, copyError] = useCopied()

  const save = async () => {
    setSaving(true)
    setSaveError("")
    try {
      const result = await bridge.setup.saveScript()
      if (result.saved) setSaved({ folder: result.folder, fileName: result.fileName })
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const runCommand = setupCommand(saved?.folder, saved?.fileName)

  return (
    <div className="space-y-4 rounded-3xl bg-blue-50/60 p-5 text-sm text-gray-700">
      <div className="flex items-start gap-3">
        <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-coral-500 text-white" aria-hidden="true">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-base font-medium text-gray-900">Create the app registration</h2>
          <p className="text-gray-600">Once per tenant, in a few minutes. Skip this if it already exists.</p>
        </div>
      </div>
      <p>
        TenuVault signs in through an app registration in your own tenant: a public client with no secret and delegated
        permissions only. A setup script creates it. Run it as a {CONSENT_ROLES.slice(0, -1).join(", ")} or{" "}
        {CONSENT_ROLES.at(-1)}, who can grant admin consent.
      </p>

      <ol className="space-y-4">
        <Step number={1} title="Save the setup script">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="mr-2 h-4 w-4" aria-hidden="true" />}
              Save setup script
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void copy("script", setupScript)}>
              {copied === "script" ? <Check className="mr-2 h-4 w-4" aria-hidden="true" /> : <Copy className="mr-2 h-4 w-4" aria-hidden="true" />}
              {copied === "script" ? "Copied" : "Copy script"}
            </Button>
          </div>
          {saved?.folder && (
            <p role="status" className="text-xs text-gray-600">
              Saved to <span className="break-all font-mono text-gray-800">{saved.folder}</span>
            </p>
          )}
          {copied === "script" && <p role="status" className="text-xs text-gray-600">Paste it into a text editor and save it as {SETUP_SCRIPT_FILE_NAME}.</p>}
          {saveError && <p role="alert" className="text-xs text-red-700">{saveError}</p>}
        </Step>
        <Step number={2} title="Run it in PowerShell">
          <p className="text-gray-600">Open PowerShell, PowerShell 7 (pwsh) on macOS, and run the command. The script installs nothing.</p>
          <CommandLine command={runCommand} label="Copy the command" copied={copied === "command"} onCopy={() => void copy("command", runCommand)} />
          <p className="text-xs text-gray-600">
            If PowerShell refuses to run the script, run{" "}
            <code className="whitespace-nowrap font-mono text-gray-800">Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass</code> first. It
            applies to this window only.
          </p>
        </Step>
        <Step number={3} title="Sign in in your browser">
          <p className="text-gray-600">
            The script opens your browser. Choose your admin account. Microsoft may first ask you to consent to Microsoft
            Graph Command Line Tools, which the script signs in through to create the app registration.
          </p>
        </Step>
        <Step number={4} title="Return to TenuVault">
          <p className="text-gray-600">
            The script prints the Tenant id and the Application (client) id and copies them to your clipboard. TenuVault
            fills them in on the next step.
          </p>
        </Step>
      </ol>

      <PermissionList />

      <div className="flex flex-wrap gap-2 border-t border-blue-100 pt-4">
        <Button type="button" variant="outline" size="sm" onClick={() => void copy("handoff", setupHandoffText())}>
          {copied === "handoff" ? <Check className="mr-2 h-4 w-4" aria-hidden="true" /> : <Send className="mr-2 h-4 w-4" aria-hidden="true" />}
          {copied === "handoff" ? "Copied" : "Someone else is the admin? Copy instructions"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void bridge.app.openExternal(MANUAL_APP_REGISTRATION_URL)}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
          Create it by hand instead
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void bridge.app.openExternal(APP_REGISTRATION_GUIDE_URL)}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
          Setup guide
        </Button>
      </div>
      {copied === "handoff" && (
        <p role="status" className="text-xs text-gray-600">
          Send the instructions to your Entra administrator by email or chat. TenuVault keeps your place here, so you can
          close it and continue when they send back the two values.
        </p>
      )}
      {copyError && <p role="alert" className="text-xs text-red-700">Could not copy: {copyError}</p>}
    </div>
  )
}

export interface SignInFields {
  tenant: string
  clientId: string
  displayName: string
}

interface TenantSignInFormProps {
  onSignedIn: (account: SignedInAccount, displayName: string) => void
  /** Called with every change to the fields, so a caller can keep them. */
  onFieldsChange?: (fields: SignInFields) => void
  submitLabel?: string
  initial?: Partial<SignInFields>
  /**
   * Set right after the in-app setup made the app registration: the form signs in once by itself,
   * as this account, so the browser's session is used and the admin has nothing to enter.
   */
  autoSignIn?: { loginHint: string } | null
  /** Leaves out the box for pasted script output, when the IDs came from the in-app setup. */
  hidePaste?: boolean
}

/** Tenant, client id and optional display name, then interactive Microsoft sign-in. */
export function TenantSignInForm({ onSignedIn, onFieldsChange, submitLabel = "Sign in with Microsoft", initial, autoSignIn, hidePaste = false }: TenantSignInFormProps) {
  const [tenant, setTenant] = useState(initial?.tenant ?? "")
  const [clientId, setClientId] = useState(initial?.clientId ?? "")
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "")
  const [pasted, setPasted] = useState("")
  const [pasteNote, setPasteNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [automatic, setAutomatic] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [errors, setErrors] = useState<{ tenant?: string; clientId?: string; form?: string }>({})
  const notify = useRef(onFieldsChange)
  notify.current = onFieldsChange

  useEffect(() => { notify.current?.({ tenant, clientId, displayName }) }, [tenant, clientId, displayName])

  // The setup script leaves its two closing lines on the clipboard. While both ID fields are empty,
  // take them from there when the form opens and when the admin comes back to the window.
  const latestFields = useRef({ tenant, clientId, busy })
  latestFields.current = { tenant, clientId, busy }
  const filledFromClipboard = useRef("")
  useEffect(() => {
    let active = true
    const check = async () => {
      if (latestFields.current.tenant || latestFields.current.clientId || latestFields.current.busy) return
      try {
        const ids = await bridge.setup?.clipboardIds?.()
        const current = latestFields.current
        if (!active || !ids || current.tenant || current.clientId || current.busy) return
        // An admin who cleared the fields does not get the same pair back on the next focus.
        const pair = `${ids.tenantId} ${ids.clientId}`
        if (filledFromClipboard.current === pair) return
        filledFromClipboard.current = pair
        latestFields.current = { ...current, tenant: ids.tenantId, clientId: ids.clientId }
        setTenant(ids.tenantId)
        setClientId(ids.clientId)
        setPasteNote({ ok: true, text: "Filled in the tenant ID and the client ID from your clipboard." })
      } catch { /* Older bridges and unavailable clipboards are harmless. */ }
    }
    void check()
    window.addEventListener("focus", check)
    return () => { active = false; window.removeEventListener("focus", check) }
  }, [])

  /** Fills the fields from pasted script output; returns whether anything was found. */
  const applyOutput = (text: string): boolean => {
    const found = parseSetupOutput(text)
    if (found.tenantId) setTenant(found.tenantId)
    if (found.clientId) setClientId(found.clientId)
    if (!found.tenantId && !found.clientId) return false
    setErrors({})
    setPasteNote({
      ok: true,
      text: found.tenantId && found.clientId
        ? "Filled in the tenant ID and the client ID."
        : found.tenantId ? "Filled in the tenant ID. The client ID was not in the pasted text." : "Filled in the client ID. The tenant ID was not in the pasted text.",
    })
    return true
  }

  const onPasteOutput = (value: string) => {
    setPasted(value)
    if (!value.trim()) { setPasteNote(null); return }
    if (!applyOutput(value)) {
      setPasteNote({ ok: false, text: "No IDs found. Paste the lines that start with Tenant id and Application (client) id." })
    }
  }

  // Pasting the whole output into one of the ID fields fills both.
  const onFieldPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text")
    if (!/\n|id\s*:/i.test(text)) return
    if (applyOutput(text)) event.preventDefault()
  }

  const submit = async (loginHint?: string) => {
    // Enter can fire while a sign-in window is already open.
    if (busy) return
    const next: typeof errors = {}
    if (!GUID.test(tenant.trim()) && !DOMAIN.test(tenant.trim())) next.tenant = "Enter a tenant id or a domain such as contoso.onmicrosoft.com."
    if (!GUID.test(clientId.trim())) next.clientId = "The client id is a GUID, printed by the setup script."
    setErrors(next)
    if (next.tenant || next.clientId) { document.getElementById(next.tenant ? "tenant" : "clientId")?.focus(); return }

    setBusy(true)
    setAutomatic(Boolean(loginHint))
    setCancelling(false)
    try {
      const account = await (loginHint ? bridge.auth.signIn(tenant.trim(), clientId.trim(), { loginHint }) : bridge.auth.signIn(tenant.trim(), clientId.trim()))
      onSignedIn(account, displayName.trim())
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sign-in failed."
      if (message !== CANCELLED && !showCommunityLimitError(error)) setErrors({ form: message })
    } finally {
      setBusy(false)
      setAutomatic(false)
      setCancelling(false)
    }
  }

  // Straight after the in-app setup: sign in once, without asking for a click.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoSignIn || autoStarted.current) return
    autoStarted.current = true
    void submit(autoSignIn.loginHint)
    // Only the first render with the request counts; later field changes must not sign in again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSignIn])

  const cancel = async () => {
    setCancelling(true)
    try {
      await bridge.auth.cancelSignIn()
    } catch (error) {
      setCancelling(false)
      setErrors({ form: error instanceof Error ? error.message : "Could not cancel the sign-in." })
    }
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, placeholder: string, error?: string, paste = false) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        placeholder={placeholder}
        value={value}
        onChange={(e) => set(e.target.value)}
        onPaste={paste ? onFieldPaste : undefined}
        spellCheck={false}
        autoComplete="off"
        disabled={busy}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={error ? "border-red-400 focus-visible:ring-red-400" : undefined}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
      />
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-red-700">{error}</p>}
    </div>
  )

  // What to do while the browser is open. The automatic sign-in after the in-app setup shows it
  // first, because there the admin did not press a button on this step.
  const status = busy && (
    <div role="status" className="space-y-3 rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-700">
      {automatic
        ? <>
            <p>Your browser opens once more to sign you in through the new app registration. There is nothing to enter this time. TenuVault then checks the license for this tenant.</p>
            <p className="text-xs text-gray-600">If Microsoft says it cannot find the application, it has not finished publishing the new app registration. Wait a minute, select Cancel sign-in and sign in again.</p>
          </>
        : <p>Complete the sign-in in your browser. TenuVault then checks the license for this tenant.</p>}
      <p className="text-xs text-gray-600">
        If Microsoft reports a device or compliance problem, Conditional Access needs a browser that passes the device
        identity, such as Microsoft Edge signed in to your work profile. Make it your default browser, cancel and sign in
        again.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => void cancel()} disabled={cancelling}>
        <X className="mr-2 h-4 w-4" aria-hidden="true" />
        {cancelling ? "Cancelling..." : "Cancel sign-in"}
      </Button>
    </div>
  )

  return (
    <div className="space-y-4">
      {automatic && status}
      {!hidePaste && (
        <div className="space-y-1.5">
          <Label htmlFor="setup-output" className="flex items-center gap-2">
            <ClipboardPaste className="h-4 w-4" aria-hidden="true" /> Paste the script output
          </Label>
          <textarea
            id="setup-output"
            rows={4}
            value={pasted}
            onChange={(e) => onPasteOutput(e.target.value)}
            disabled={busy}
            spellCheck={false}
            placeholder={"Tenant id:                00000000-0000-0000-0000-000000000000\nApplication (client) id:  00000000-0000-0000-0000-000000000000"}
            aria-describedby="setup-output-note"
            className="flex w-full rounded-2xl border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <p id="setup-output-note" role="status" className={pasteNote && !pasteNote.ok ? "text-xs text-red-700" : "text-xs text-gray-600"}>
            {pasteNote?.text ?? "Or type the values below."}
          </p>
        </div>
      )}
      {field("tenant", "Tenant id or domain", tenant, setTenant, "contoso.onmicrosoft.com", errors.tenant, true)}
      {field("clientId", "Application (client) id", clientId, setClientId, "00000000-0000-0000-0000-000000000000", errors.clientId, true)}
      {field("displayName", "Display name (optional)", displayName, setDisplayName, "Contoso Production")}
      {errors.form && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{trialKeyRefusalText(errors.form)}
            <TrialKeyRefusalActions message={errors.form} source="sign-in-trial-key-refused" />
          </AlertDescription>
        </Alert>
      )}
      <Button onClick={() => void submit()} disabled={busy || !tenant || !clientId} className="w-full bg-blue-600 hover:bg-blue-700">
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
        {busy ? "Waiting for sign-in..." : submitLabel}
      </Button>
      {!automatic && status}
    </div>
  )
}
