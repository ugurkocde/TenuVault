import { trialKeyRefusalText } from "../../shared/trial-notices"
import { TenantTrialCard, TenantTrialOptions, TrialActions, TrialKeyRefusalActions, trialEndVisible } from "../components/TenantTrial"
import { CommunityTenantChoiceButton } from "../components/CommunityTenantPicker"
import { useEffect, useRef, useState, type MouseEvent, type Ref } from "react"
import { Link, useLocation } from "react-router-dom"
import {
  AlertCircle,
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Clock,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Sparkles,
  WifiOff,
} from "lucide-react"
import { useTenants } from "~/contexts/TenantContext"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Checkbox } from "~/components/ui/checkbox"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import type { LicenseStatus, TenantLicenseStatus } from "../../shared/ipc"
import { INVOICE_REQUEST_EMAIL, INVOICE_REQUEST_URL, TRIAL_USED_MESSAGE } from "../../shared/constants"
import { LicenseAgreementLink } from "../components/LicenseAgreementDialog"
import { TrialSignupForm } from "../components/TrialSignupForm"
import { useClipboardLicenseKey } from "../lib/clipboard-key"
import { openCheckout } from "../lib/purchase"
import { bridge } from "../lib/bridge"
import { useConfirm } from "~/components/ConfirmDialog"
import { formatDate, formatDateTime, hasPaidLicense, isUnlicensed, licensePageTitle, planName, savedKeyNotNeededHere, tenantPlanName, trialDaysLeft, trialUsedUp, useLicense } from "../lib/license"

type Busy = "activate" | "replace" | "deactivate" | `retry:${string}` | `share:${string}` | null

function useAction() {
  const { refresh } = useLicense()
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const run = async (name: Busy, action: () => Promise<LicenseStatus | void>, success?: (result: LicenseStatus | void) => string | null) => {
    setBusy(name)
    setError("")
    setNotice("")
    try {
      const result = await action()
      setNotice(success?.(result) ?? "")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      await refresh()
    }
  }
  return { busy, error, notice, run }
}

function openExternalLink(event: MouseEvent<HTMLAnchorElement>, url: string) {
  event.preventDefault()
  void bridge.app.openExternal(url)
}

/**
 * For buyers who cannot pay by card: yearly plans by quote, purchase order and invoice,
 * requested by email, as on the pricing page.
 */
function InvoiceNote() {
  return (
    <p className="text-sm text-gray-600">
      <span className="font-medium text-gray-900">Need an invoice instead of a card?</span> For yearly Pro and MSP plans we
      send a quote, accept your purchase order and invoice you for payment by bank transfer. Email{" "}
      <a href={INVOICE_REQUEST_URL} className={linkClass} onClick={(event) => openExternalLink(event, INVOICE_REQUEST_URL)}>
        {INVOICE_REQUEST_EMAIL}
      </a>
      .
    </p>
  )
}

const linkClass = "text-blue-600 underline underline-offset-4 hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"

function TrialCallToAction({ emailRef, onSent }: { emailRef: Ref<HTMLInputElement>; onSent: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-blue-50/60 p-5" id="trial">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-3 text-base font-medium text-gray-900">
          <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-coral-500 text-white" aria-hidden="true">
            <Sparkles className="h-4 w-4" />
          </span>
          You are on Community, the free plan. Try Pro free for 30 days, no card needed.
        </p>
        <p className="mt-2 text-sm text-gray-600">
          Community covers one tenant with manual and weekly backups. Pro covers two tenants and adds daily backups, full
          restore, replace in place, drift revert, Azure storage, the audit log and white-label PDF reports. New MSP subscriptions include 5
          tenants and add cross tenant views and bulk actions.
        </p>
      </div>
      <div className="w-full space-y-3">
        <TrialSignupForm ref={emailRef} source="license-page" onSent={onSent} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-600">
          <span>Ready to buy?</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void openCheckout("license-page")}>
            <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
            Buy now
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void bridge.license.open("buy", { source: "license-page" })}>
            Compare plans
          </Button>
        </div>
        <InvoiceNote />
        <p className="text-sm text-gray-600">
          <a href="https://docs.tenuvault.com/licensing/" className={linkClass} onClick={(event) => openExternalLink(event, "https://docs.tenuvault.com/licensing/")}>
            Eligible nonprofits can use Pro at no cost.
          </a>
        </p>
      </div>
    </div>
  )
}

/**
 * Swaps this machine's key for another one in the main process: the new key is activated
 * first and the saved key released only once it was accepted, so organization licenses and
 * the current key survive a refused key.
 */
function ReplaceKeyForm({ busy, onReplace }: { busy: Busy; onReplace: (key: string) => void }) {
  const [newKey, setNewKey] = useState("")
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (newKey.trim()) onReplace(newKey.trim())
      }}
    >
      <Label htmlFor="replacement-key">New license key</Label>
      <div className="flex gap-2">
        <Input
          id="replacement-key"
          autoComplete="off"
          className="font-mono"
          placeholder="Paste the key from your purchase email"
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
          spellCheck={false}
          disabled={busy !== null}
        />
        <Button type="submit" disabled={busy !== null || !newKey.trim()}>
          {busy === "replace" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
          Use this key
        </Button>
      </div>
      <p className="text-xs text-gray-500">The new key is activated for your tenants first. Only then is the saved key released from this machine.</p>
    </form>
  )
}

/**
 * A saved key that no longer licenses anything, such as an ended trial: buy a plan and
 * swap in the new key without deactivating the machine first.
 */
function InactiveKeyReplacement({ status, busy, onReplace }: { status: LicenseStatus; busy: Busy; onReplace: (key: string) => void }) {
  const [replacing, setReplacing] = useState(false)
  const showPurchase = (!status.trialEndedAt || !status.tenantTrialsEnabled) && !status.tenants.some(tenant => tenant.message === TRIAL_USED_MESSAGE)
  return (
    <div className="space-y-3 rounded-3xl bg-gray-50 p-5">
      <p className="text-sm text-gray-700">
        {status.trialEndedAt
          ? `Your Pro trial ended on ${formatDate(status.trialEndedAt)}. One tenant continues on Community. Buy Pro, then copy the key from your purchase email and return to TenuVault: it replaces the trial key by itself. Or enter it here.`
          : "Your saved key is not active, for example because your trial ended. Bought a new license? Enter its key here."}
      </p>
      {status.trialEndedAt && status.tenantTrialsEnabled && <TrialActions source="license-page-trial-ended" />}
      <div className="flex flex-wrap gap-2">
        {showPurchase && <Button type="button" onClick={() => void openCheckout(status.trialEndedAt ? "license-page-trial-ended" : "license-page-inactive")}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
          Buy Pro
        </Button>}
        {!replacing && (
          <Button type="button" variant="outline" onClick={() => setReplacing(true)}>
            <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
            Enter a new key
          </Button>
        )}
      </div>
      {replacing && <ReplaceKeyForm busy={busy} onReplace={onReplace} />}
      {showPurchase && <InvoiceNote />}
    </div>
  )
}

/** A running no-card trial: when it ends, buying Pro, and swapping in the paid key. */
function TrialStatus({ status, busy, onReplace }: { status: LicenseStatus; busy: Busy; onReplace: (key: string) => void }) {
  const [replacing, setReplacing] = useState(false)
  const daysLeft = trialDaysLeft(status)
  if (daysLeft === null || !status.trialEndsAt) return null
  return (
    <div className="space-y-3 rounded-3xl bg-blue-50/60 p-5">
      <p className="flex items-center gap-3 text-base font-medium text-gray-900">
        <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-coral-500 text-white" aria-hidden="true">
          <Clock className="h-4 w-4" />
        </span>
        Your Pro trial ends on {formatDate(status.trialEndsAt)}, {daysLeft === 1 ? "in 1 day" : `in ${daysLeft} days`}.
      </p>
      <p className="text-sm text-gray-600">
        Nothing is charged when it ends. One tenant continues on Community, any other tenant is no longer covered, and
        Pro features turn off. Your backups stay where they are. To keep Pro, buy a plan, then copy the license key from the purchase email and return to TenuVault: it replaces the trial key by itself. Or enter it here.
      </p>
      {status.tenantTrialsEnabled && <TrialActions source="license-page-trial" />}
      <div className="flex flex-wrap gap-2">
        {!status.tenantTrialsEnabled && <Button type="button" onClick={() => void openCheckout("license-page-trial")}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />Buy Pro
        </Button>}
        <Button type="button" variant="outline" onClick={() => void openCheckout("license-page-trial", { plan: "msp" })}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
          Buy MSP
        </Button>
        {!replacing && (
          <Button type="button" variant="ghost" onClick={() => setReplacing(true)}>
            <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
            Enter your new key
          </Button>
        )}
      </div>
      {replacing && <ReplaceKeyForm busy={busy} onReplace={onReplace} />}
      {!status.tenantTrialsEnabled && <InvoiceNote />}
    </div>
  )
}

function TenantRow({
  tenant,
  name,
  busy,
  onRetry,
  onShare,
  choicePending,
}: {
  tenant: TenantLicenseStatus
  name: string | undefined
  busy: Busy
  onRetry: () => void
  onShare: (shared: boolean) => void
  choicePending: boolean
}) {
  const organization = tenant.entitled && tenant.source === "tenant"
  const keyHolder = tenant.entitled && tenant.source === "key"
  return (
    <div className="space-y-2 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-gray-900">{name ?? tenant.tenantId}</p>
          <p className="truncate font-mono text-xs text-gray-500">{tenant.tenantId}</p>
        </div>
        {tenant.entitled ? (
          <Badge variant="green">{tenant.trial ? tenantPlanName(tenant) : organization ? `Active through your organization (${planName(tenant.plan)})` : `Active, ${planName(tenant.plan)}`}</Badge>
        ) : tenant.plan === "community" && !choicePending ? (
          <Badge variant="gray">Community (free)</Badge>
        ) : tenant.signedIn ? (
          <Badge variant="orange">Not active</Badge>
        ) : (
          <Badge variant="gray">Not signed in</Badge>
        )}
        {tenant.signedIn && !tenant.entitled && (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={onRetry}>
            {busy === `retry:${tenant.tenantId}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Retry
          </Button>
        )}
      </div>
      {tenant.entitled && tenant.expiresAt && (
        <p className="text-xs text-gray-500">
          {tenant.validUntil ? `${tenant.trial ? "Trial ends" : "Valid until"} ${formatDate(tenant.validUntil)} · ` : ""}
          Works offline until {formatDateTime(tenant.expiresAt)}
          {organization && tenant.displayKey ? ` · Organization license ${tenant.displayKey}` : ""}
        </p>
      )}
      {!tenant.entitled && tenant.message && <>
        <p className="text-xs text-orange-700">{trialKeyRefusalText(tenant.message)}</p>
        <TrialKeyRefusalActions message={tenant.message} tenant={tenant} source="license-page-trial-key-refused" />
      </>}
      {!tenant.entitled && tenant.plan !== "community" && tenant.signedIn && tenant.coverageEnded && !choicePending && <p className="text-xs text-gray-600">Backups of this tenant are kept. Add a license to use it again.</p>}
      {keyHolder && (
        <div className="rounded-2xl bg-gray-50 p-4">
          <label className="flex items-center gap-2 text-sm text-gray-900">
            <Checkbox
              checked={tenant.shared === true}
              disabled={busy !== null}
              onCheckedChange={(checked) => onShare(checked === true)}
            />
            Let other admins in this tenant use this license
            {busy === `share:${tenant.tenantId}` && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </label>
          <p className="mt-1 text-xs text-gray-500">
            Anyone who signs in to this tenant with the same TenuVault app registration is licensed automatically. The key
            stays on this machine.
          </p>
          {tenant.shareNeedsSignIn && (
            <p className="mt-1 text-xs text-orange-700">Sign in to this tenant again to share the license with it.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function LicensePage() {
  const { confirm, confirmDialog } = useConfirm()
  const { status, error: statusError, refresh } = useLicense()
  const tenants = useTenants()
  const [key, setKey] = useState("")
  const keyInput = useRef<HTMLInputElement>(null)
  const [trialKeyHint, setTrialKeyHint] = useState(false)
  const [replacingActive, setReplacingActive] = useState(false)
  const trialEmail = useRef<HTMLInputElement>(null)
  const { busy, error, notice, run } = useAction()
  const checkedOnOpen = useRef(false)
  const activateKey = (value: string) =>
    void run(
      "activate",
      async () => {
        const result = await bridge.license.setKey(value)
        setKey("")
        return result
      },
      (result) =>
        result && result.tenants.some((t) => t.entitled && t.source === "key")
          ? "License activated."
          : result && savedKeyNotNeededHere(result)
            ? "License key saved. Your signed-in tenants are already licensed through your organization."
            : "License key saved. It activates for a tenant when you sign in to it.",
    )
  // The trial key arrives by email: once it is copied there, it activates when TenuVault gets focus.
  useClipboardLicenseKey(trialKeyHint && status?.hasKey === false && busy === null, (found) => {
    setKey(found)
    activateKey(found)
  })
  // Other screens send the admin here to start the trial.
  const startTrial = (useLocation().state as { startTrial?: boolean } | null)?.startTrial === true
  const unlicensed = status ? isUnlicensed(status) : false
  useEffect(() => {
    if (!startTrial || !unlicensed) return
    trialEmail.current?.scrollIntoView({ block: "center" })
    trialEmail.current?.focus({ preventScroll: true })
  }, [startTrial, unlicensed])

  useEffect(() => {
    // A failed read is shown below through the provider's error.
    void refresh().catch(() => undefined)
    if (checkedOnOpen.current) return
    checkedOnOpen.current = true
    // A plan or tenant quantity changed in the customer portal under the same key only
    // reaches the cached tokens at the next periodic check, up to 6 hours later. Opening
    // this page asks the service now; failures keep the cached status shown above.
    void bridge.license.refresh().then(() => refresh()).catch(() => undefined)
  }, [refresh])

  if (!status && statusError) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>The license status could not be read: {statusError}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => void refresh().catch(() => undefined)}>
          <RefreshCw className="h-4 w-4" />
          Try again
        </Button>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    )
  }

  const nameOf = (tenantId: string) =>
    tenants.find((t) => t.credentials?.tenantId?.toLowerCase() === tenantId)?.name
  const tenantRows: TenantLicenseStatus[] = [...status.tenants]
  for (const profile of tenants) {
    const id = profile.credentials?.tenantId.toLowerCase()
    if (id && !tenantRows.some(row => row.tenantId.toLowerCase() === id)) {
      tenantRows.push({
        tenantId: id, signedIn: false, activated: false, entitled: false,
        source: null, plan: null, tenants: null, expiresAt: null, validUntil: null, trial: false, shared: null,
        shareNeedsSignIn: false, displayKey: null, message: 'Sign in to check this tenant’s license.',
      })
    }
  }
  const activeKeyTenants = status.tenants.filter((t) => t.entitled && (t.source === "key" || !status.hasKey && t.source === "trial")).length
  const signedIn = status.tenants.filter((t) => t.signedIn).length

  const activate = () => activateKey(key.trim())
  const replaceKey = (newKey: string) =>
    void run(
      "replace",
      () => bridge.license.replaceKey(newKey),
      (result) =>
        result && result.tenants.some((t) => t.entitled && t.source === "key")
          ? "Your new license is active."
          : result && savedKeyNotNeededHere(result)
            ? "License key saved. Your signed-in tenants are already licensed through your organization."
            : "Your new license key is saved. It activates for a tenant when you sign in to it.",
    )
  const deactivate = async () => {
    if (!(await confirm({ title: "Deactivate this machine?", description: "Backups that require this license will stop. Your existing backups remain available. Save your license key so you can activate again.", confirmLabel: "Deactivate", destructive: true }))) return
    void run("deactivate", () => bridge.license.deactivate(), () =>
      status.hasKey
        ? "This machine was deactivated. You can use the key on another machine."
        : "This machine was deactivated.",
    )
  }
  const retry = (tenantId: string) =>
    void run(`retry:${tenantId}`, () => bridge.license.retry(tenantId), (result) =>
      result?.tenants.find((t) => t.tenantId === tenantId)?.entitled ? "License activated for this tenant." : null,
    )
  const share = (tenantId: string, shared: boolean) =>
    void run(`share:${tenantId}`, () => bridge.license.setShared(tenantId, shared), () =>
      shared
        ? "Other admins in this tenant can now use this license after signing in."
        : "Other admins in this tenant can no longer use this license.",
    )

  const title = licensePageTitle(status)
  // After a used trial the page offers Buy Pro once: not when the ended notice above the page,
  // a trial card below or a refused trial key's message already carries it.
  const trialUsed = trialUsedUp(status)
  const buyAfterTrial = trialUsed && !trialEndVisible(status)
    && !status.tenants.some(t => (t.source === "trial" || t.trialCanExtend && t.trialAcknowledged) && !(t.entitled && !t.trialAcknowledged))
    && ![error, status.keyMessage, signedIn > 0 ? status.message : null].some(message => message?.includes(TRIAL_USED_MESSAGE))

  return (
    <div className="max-w-5xl space-y-6 p-6 lg:p-8">
      {confirmDialog}
      <div>
        <h1 className="text-4xl font-medium tracking-tight text-gray-900">License</h1>
        <p className="mt-2 max-w-3xl text-base text-gray-500">
          Each tenant you connect needs a license. TenuVault checks it with tenuvault.com when a tenant is first used and
          every few hours, and keeps working offline for up to 14 days after the last check.
        </p>
      </div>

      <Card>
        <CardHeader className="p-7 pb-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-3 text-2xl font-medium">
                <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-full bg-secondary" aria-hidden="true">
                  {status.plan ? (
                    <BadgeCheck className="h-[18px] w-[18px] text-green-600" />
                  ) : (
                    <KeyRound className="h-[18px] w-[18px] text-gray-600" />
                  )}
                </span>
                {title}
              </CardTitle>
              {status.validUntil && (
                <p className="mt-2 text-base font-medium text-gray-900">
                  {new Set(status.tenants.map((t) => t.validUntil).filter(Boolean)).size > 1 ? "Earliest license expiry" : "License valid until"} {formatDate(status.validUntil)}
                </p>
              )}
              <CardDescription className="mt-2">
                {isUnlicensed(status)
                  ? trialUsed
                    ? "Paste your license key, or buy Pro for daily backups, full restore and drift revert."
                    : "Paste the license key from your email, or start a free trial."
                  : status.plan
                    ? `Your license covers ${status.tenantLimit ?? 1} tenant${status.tenantLimit === 1 ? "" : "s"}. ${activeKeyTenants} ${activeKeyTenants === 1 ? "is" : "are"} active on this machine.`
                    : savedKeyNotNeededHere(status)
                      ? "A tenant admin shared their TenuVault license with your tenant."
                      : hasPaidLicense(status)
                        ? "A tenant admin shared their TenuVault license with your tenant."
                        : status.keyState === "failed"
                          ? "Your saved key is not active. Check the license message and the tenants below."
                          : status.keyState === "pending"
                            ? signedIn === 0
                              ? "Your key is saved. It activates for a tenant when you sign in to it."
                              : "Your key is saved but not active for your signed-in tenants. Check the tenants below."
                            : "Your organization license is not currently active. Sign in again and retry the license check below."}
              </CardDescription>
            </div>
            {status.plan && <Badge variant="secondary">{status.trial ? "Pro trial" : planName(status.plan)}</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-5 px-7 pb-7">
          {status.offline && (
            <Alert>
              <WifiOff className="h-4 w-4" />
              <AlertDescription>
                The licensing service could not be reached. Tenants that are already active keep working until their
                verification expires.
              </AlertDescription>
            </Alert>
          )}
          {(status.keyMessage || (status.message && signedIn > 0)) && (
            <Alert>
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription>{trialKeyRefusalText(status.keyMessage ?? status.message ?? "")}
                <TrialKeyRefusalActions message={status.keyMessage ?? status.message ?? ""} source="license-page-trial-key-refused" />
              </AlertDescription>
            </Alert>
          )}

          {isUnlicensed(status) && !status.tenantTrialsEnabled && <TrialCallToAction emailRef={trialEmail} onSent={() => setTrialKeyHint(true)} />}
          {<TenantTrialOptions />}
          {buyAfterTrial && <TrialActions source="license-page-trial-used" />}
          {status.tenants.filter(t => t.source === "trial" || t.trialCanExtend && t.trialAcknowledged).map(t => <TenantTrialCard key={t.tenantId} tenant={t} welcome={t.entitled && !t.trialAcknowledged} allowUnknownContactRemoval />)}
          {status.trial && !status.tenants.some(t => t.source === "trial") && <TrialStatus status={status} busy={busy} onReplace={replaceKey} />}
          {savedKeyNotNeededHere(status) ? (
            <p className="text-sm text-gray-600">
              Your signed-in tenants are licensed through your organization, so this key is not needed on this computer. It stays saved and activates for a tenant that is not covered yet.
            </p>
          ) : status.hasKey && !status.trial && status.keyState !== "active" && <InactiveKeyReplacement status={status} busy={busy} onReplace={replaceKey} />}

          {status.hasKey ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-gray-50 px-5 py-4">
                <div>
                  <div className="text-xs font-medium text-gray-500">License key</div>
                  <div className="mt-1 font-mono text-sm text-gray-900">{status.keyHint}</div>
                </div>
                {status.keyState === "active" && !status.trial && !replacingActive && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setReplacingActive(true)}>
                    <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
                    Use a different key
                  </Button>
                )}
              </div>
              {replacingActive && <ReplaceKeyForm busy={busy} onReplace={replaceKey} />}
            </div>
          ) : (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (key.trim()) activate()
              }}
            >
              <Label htmlFor="license-key">License key</Label>
              <div className="flex gap-2">
                <Input
                  id="license-key"
                  ref={keyInput}
                  name="license-key"
                  autoComplete="off"
                  aria-describedby={trialKeyHint ? "trial-key-hint" : undefined}
                  className="font-mono"
                  placeholder="Paste the key from your email"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  spellCheck={false}
                  disabled={busy !== null}
                />
                <Button type="submit" disabled={busy !== null || !key.trim()}>
                  {busy === "activate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  Activate
                </Button>
              </div>
              {trialKeyHint && <p id="trial-key-hint" className="text-sm text-gray-600">Copy the key from your email and return to TenuVault: it activates by itself. Or paste it here.</p>}
              <p className="text-xs text-gray-500">
                Licensed through your organization? <Link to="/portal/onboarding" className="text-blue-600 hover:underline">Sign in to your tenant</Link>{" "}
                and TenuVault uses the license a tenant admin shared with it.
              </p>
            </form>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{trialKeyRefusalText(error)}
                <TrialKeyRefusalActions message={error} tenant={status.tenants.find(tenant => tenant.message === error)} source="license-page-trial-key-refused" />
              </AlertDescription>
            </Alert>
          )}
          {notice && (
            <Alert>
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            {status.hasKey && (
              <Button variant="outline" onClick={() => void bridge.license.open("portal")}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Manage subscription
              </Button>
            )}
            {!isUnlicensed(status) && (
              <Button variant="ghost" disabled={busy !== null} onClick={deactivate}>
                {busy === "deactivate" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Deactivate this machine
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {tenantRows.length > 0 && (
        <Card>
          <CardHeader className="p-7 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="text-xl font-medium">Tenants</CardTitle><CommunityTenantChoiceButton /></div>
            <CardDescription>
              The license state of every tenant on this machine. Removing a tenant from TenuVault frees its place on the
              license.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-7 pb-7">
            <div className="divide-y divide-gray-100">
              {tenantRows.map((tenant) => (
                <TenantRow
                  key={tenant.tenantId}
                  tenant={tenant}
                  choicePending={status.communityChoicePendingTenantIds?.includes(tenant.tenantId) ?? false}
                  name={nameOf(tenant.tenantId)}
                  busy={busy}
                  onRetry={() => retry(tenant.tenantId)}
                  onShare={(shared) => share(tenant.tenantId, shared)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-gray-500">
        Tenant trials store a keyed hash of the tenant ID. An optional trial email is sent only when you submit it. License checks send the license key, your Microsoft sign-in (ID) token or both: the token proves the tenant for an
        organization license, a tenant trial or for sharing the license with it, is verified and only its tenant ID used, never stored. They also send a random installation ID, the tenant ID, the app
        registration client ID and the app version. Tenant configuration and backups are never sent.
        {!status.persisted &&
          " Secure storage is not available on this system, so the license is kept in memory only and must be entered again after a restart."}
      </p>

      <p className="text-xs text-gray-500">
        Official TenuVault builds are licensed under the <LicenseAgreementLink label="license agreement" />. The source
        code is available under the Business Source License 1.1.
      </p>
    </div>
  )
}
