import { useId, useRef, useState } from "react"
import { AlertCircle, Building2, CheckCircle2, KeyRound, Loader2, Sparkles } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import type { LicenseStatus } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { useClipboardLicenseKey } from "../lib/clipboard-key"
import { tenantLicense, tenantPlan, useLicense } from "../lib/license"
import { TenantTrialCard, TenantTrialOptions } from "./TenantTrial"
import { TrialSignupForm } from "./TrialSignupForm"

/**
 * The license key field. While `watchClipboard` is on (a trial key is on its way by email), a key
 * copied from the email is filled in and saved as soon as TenuVault gets focus.
 */
export function LicenseKeyEntry({ watchClipboard = false, onSaved, label = "License key" }: {
  watchClipboard?: boolean
  onSaved?: (status: LicenseStatus) => void
  label?: string
}) {
  const id = useId()
  const { refresh } = useLicense()
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [fromClipboard, setFromClipboard] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const save = async (value: string) => {
    setBusy(true)
    setError("")
    try {
      const status = await bridge.license.setKey(value.trim())
      setKey("")
      onSaved?.(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      await refresh().catch(() => undefined)
    }
  }

  useClipboardLicenseKey(watchClipboard && !busy, (found) => {
    setKey(found)
    setFromClipboard(true)
    void save(found)
  })

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (key.trim() && !busy) void save(key)
      }}
    >
      <Label htmlFor={`${id}-key`}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={`${id}-key`}
          ref={input}
          name="license-key"
          placeholder="Paste the key from your email"
          value={key}
          onChange={(event) => { setKey(event.target.value); setError(""); setFromClipboard(false) }}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : `${id}-help`}
          className="font-mono"
          disabled={busy}
        />
        <Button type="submit" variant="outline" disabled={busy || !key.trim()}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />}
          Save key
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive" id={`${id}-error`} role="alert">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <p id={`${id}-help`} role="status" className="text-xs text-gray-600">
          {busy && fromClipboard
            ? "Saving the key you copied from the email..."
            : watchClipboard
              ? "Copy the key from the email and return to TenuVault: it is saved by itself. Or paste it here."
              : "The key is saved on this device and activated for your tenant when you sign in."}
        </p>
      )}
    </form>
  )
}

/** The trial and license key options, collapsed behind quiet links until one is chosen. */
export function TrialOrKey({ source, initialEmail, onSaved }: { source: string; initialEmail?: string; onSaved?: (status: LicenseStatus) => void }) {
  const [open, setOpen] = useState<"trial" | "key" | null>(null)
  const { status } = useLicense()
  const [trialSent, setTrialSent] = useState(false)
  const link = "rounded-full px-1 text-sm font-medium text-blue-600 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {!status?.tenantTrialsEnabled && <button type="button" className={link} aria-expanded={open === "trial"} onClick={() => setOpen(open === "trial" ? null : "trial")}>
          Try Pro free for 30 days, no card
        </button>}
        <button type="button" className={link} aria-expanded={open === "key"} onClick={() => setOpen(open === "key" ? null : "key")}>
          I have a license key
        </button>
      </div>
      <TenantTrialOptions />
      {open === "trial" && !status?.tenantTrialsEnabled && (
        <div className="space-y-4 rounded-2xl bg-blue-50/60 p-4">
          <TrialSignupForm source={source} initialEmail={initialEmail} onSent={() => setTrialSent(true)} />
          {trialSent && <LicenseKeyEntry watchClipboard onSaved={onSaved} label="Your trial key" />}
        </div>
      )}
      {open === "key" && (
        <div className="rounded-2xl bg-gray-50 p-4">
          <LicenseKeyEntry onSaved={onSaved} />
        </div>
      )}
    </div>
  )
}

const emailLike = (value: string | undefined) => (value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : undefined)

/**
 * The plan a tenant got at sign-in, in context: Community with the trial and key next to it, or
 * the paid plan from this machine's key or shared by the tenant's organization.
 */
export function PlanContext({ tenantId, username }: { tenantId: string; username?: string }) {
  const { status } = useLicense()
  const tenant = tenantLicense(status, tenantId)
  const plan = tenantPlan(tenant)
  if (!plan) return null
  if (plan === "community") {
    return (
      <div className="space-y-3 rounded-3xl bg-gray-50 p-5 text-sm text-gray-700">
        <p className="flex items-start gap-3">
          <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-card" aria-hidden="true"><Building2 className="h-4 w-4" /></span>
          <span>
            <span className="block font-medium text-gray-900">This tenant uses Community, the free plan</span>
            Manual and weekly backups on this device, kept for 30 days. Pro adds daily backups, Azure storage, full restore
            and drift revert. You can change this later on the License page.
          </span>
        </p>
        <TrialOrKey source="setup" initialEmail={emailLike(username)} />
      </div>
    )
  }
  if (tenant?.source === "trial" && !tenant.trialAcknowledged) return <TenantTrialCard tenant={tenant} initialEmail={emailLike(username)} welcome />
  const name = plan === "msp" ? "MSP" : "Pro"
  return (
    <p className="flex items-center gap-3 rounded-3xl bg-green-50 px-5 py-3 text-sm text-green-900">
      {tenant?.trial ? <Sparkles className="h-4 w-4 flex-shrink-0" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4 flex-shrink-0" aria-hidden="true" />}
      {tenant?.source === "tenant"
        ? `This tenant uses ${name}, through the license your organization shares with it.`
        : tenant?.trial ? `This tenant uses your ${name} trial.` : `This tenant uses ${name}.`}
    </p>
  )
}
